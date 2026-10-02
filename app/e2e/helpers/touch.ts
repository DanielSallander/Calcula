/**
 * TOUCH AND PEN INPUT for the live journeys -- the instrument behind
 * `journeys/touch-pen-measure.spec.ts` (plan_M8 S10; BUG-0258 design phase 6,
 * "keyboard and touch (later; large)"). Nothing about touch had been MEASURED
 * before this file: every statement was read off the code. This is what reads
 * it off the running app instead, and it is meant to be reused by the touch
 * milestone, so it decides nothing about what touch SHOULD do.
 *
 * WHY CDP AND NOT page.mouse / page.touchscreen. The journeys attach to the
 * running WebView2 over CDP (`fixtures.ts`), so Playwright never created the
 * browser context and its `hasTouch` is false: `page.touchscreen.tap()` refuses,
 * and `page.mouse` cannot say "pen". One CDP session per test (the
 * `helpers/screenshots.ts` precedent) drives:
 *   - `Input.dispatchMouseEvent` with `pointerType: "mouse"` or `"pen"` -- the
 *     mouse is the CONTROL, made by the very same driver, so a gesture whose
 *     mouse row fails tells the reader the harness, not touch, is broken;
 *   - `Input.dispatchTouchEvent` (touchStart / touchMove / touchEnd) -- Chromium
 *     runs these through its TouchEmulator's gesture detector, which turns a tap
 *     into compatibility mouse events and a long hold into a long-press.
 * Every CDP call is bounded: `cdp.send` has no timeout of its own, and a
 * renderer that never acknowledges an input would otherwise hang the test.
 *
 * WHAT IT RECORDS.
 *   - `startInputLog` / `readInputLog`: a PASSIVE, listen-only window
 *     capture-phase recorder (never preventDefault, never stopPropagation) of
 *     what reached the page -- pointer events with their pointerType, touch
 *     events, mouse events (and how many Chromium marked as coming from touch,
 *     `sourceCapabilities.firesTouchEvents`), contextmenu (and whether something
 *     prevented its default), native scrolls, drag/selection starts -- and the
 *     pointer-capture balance: every `gotpointercapture` must be matched, and
 *     after the lift no element may still `hasPointerCapture` a pointer the
 *     gesture used. React already listens for pointer and touch events at its
 *     root, so adding passive listeners does not change which touches reach
 *     the page.
 *   - `heldPointers`: the product's OWN press sessions, read from the live
 *     modules (`__appImport`, the same instances the app loaded). They are the
 *     app's pointer capture -- window listeners held from the press to the
 *     release -- so one still armed after the finger lifted is a stuck pointer.
 *   - `openMenus`: the families' own "is my menu open" answers plus every
 *     visible `[role="menu"]` in the DOM.
 *   - `targetAt`: what is under a point and the touch-action chain above it.
 *   - `touchEnvironment`: what this machine advertises (maxTouchPoints, the
 *     pointer media queries, DPR, history length).
 *
 * Nothing in here asserts. It drives, it reads, it renders; the spec decides.
 */
import type { CDPSession, Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { bounded, installAppImport } from "./pivot-live";

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

/** The three pointer kinds measured. `mouse` is the control. */
export type PointerInput = "mouse" | "pen" | "touch";

/** Measured in this order: the control first, so a broken harness shows before any touch row is read. */
export const POINTER_INPUTS: readonly PointerInput[] = ["mouse", "pen", "touch"];

export interface ClientPoint {
  x: number;
  y: number;
}

/** No single CDP input call may take longer than this (a wedged renderer never acks). */
const CDP_MS = 10_000;

/** Called while the pointer is still down, after the gesture's moves (a probe sample, e.g. "what is armed now?"). */
export type WhileHeld = () => Promise<void>;

/**
 * Drives one pointer through CDP. At most one pointer is down at a time; the
 * driver remembers it so `releaseAll` can always lift it (a gesture that threw
 * must not leave the browser holding a button or a finger for the next test).
 */
export class PointerDriver {
  private down_: { input: PointerInput; at: ClientPoint } | null = null;

  private constructor(
    private readonly page: Page,
    private readonly cdp: CDPSession,
  ) {}

  static async open(page: Page): Promise<PointerDriver> {
    const cdp = await bounded("open a CDP session for pointer input", page.context().newCDPSession(page), CDP_MS);
    return new PointerDriver(page, cdp);
  }

  /** Lift anything still down, then detach the session. */
  async close(): Promise<void> {
    await this.releaseAll().catch(() => undefined);
    await this.cdp.detach().catch(() => undefined);
  }

  /** Whether a pointer is down right now (the driver's own book-keeping). */
  isDown(): boolean {
    return this.down_ !== null;
  }

  private async mouseEvent(
    input: "mouse" | "pen",
    type: "mousePressed" | "mouseReleased" | "mouseMoved",
    p: ClientPoint,
    contact: boolean,
  ): Promise<void> {
    // `contact`: the button (or the pen tip) is down AFTER this event.
    const changesButton = type !== "mouseMoved";
    await bounded(
      `Input.dispatchMouseEvent ${type} (${input}) at ${Math.round(p.x)},${Math.round(p.y)}`,
      this.cdp.send("Input.dispatchMouseEvent", {
        type,
        x: p.x,
        y: p.y,
        button: changesButton || contact ? "left" : "none",
        buttons: contact ? 1 : 0,
        clickCount: changesButton ? 1 : 0,
        pointerType: input,
        // A pen in contact has pressure; a pen in range (hovering) has none.
        force: input === "pen" && contact ? 0.5 : 0,
      }),
      CDP_MS,
    );
  }

  private async touchEvent(type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel", p?: ClientPoint): Promise<void> {
    await bounded(
      `Input.dispatchTouchEvent ${type}${p ? ` at ${Math.round(p.x)},${Math.round(p.y)}` : ""}`,
      this.cdp.send("Input.dispatchTouchEvent", {
        type,
        // touchEnd / touchCancel carry no points (the protocol's rule).
        touchPoints: p ? [{ x: p.x, y: p.y, id: 1, radiusX: 1, radiusY: 1, force: 1 }] : [],
      }),
      CDP_MS,
    );
  }

  /**
   * Bring the pointer to `p` WITHOUT contact: a mouse, or a pen in range,
   * hovers there (from 3 px away, so the last move is a real one). A finger
   * does not exist until it lands, so for touch this does nothing.
   */
  async approach(input: PointerInput, p: ClientPoint): Promise<void> {
    if (input === "touch") return;
    await this.mouseEvent(input, "mouseMoved", { x: p.x - 3, y: p.y - 3 }, false);
    await this.mouseEvent(input, "mouseMoved", p, false);
  }

  /**
   * Move the MOUSE (never pen or touch) to a neutral point, so a pointer the
   * previous measurement left over the grid does not hover the next one's
   * object. A real touch user's mouse is not over the grid either.
   */
  async park(p: ClientPoint): Promise<void> {
    if (this.down_) throw new Error(`cannot park: a ${this.down_.input} is down`);
    await this.mouseEvent("mouse", "mouseMoved", p, false);
  }

  /** Contact at `p`: a button press, a pen tip, a finger landing. */
  async press(input: PointerInput, p: ClientPoint): Promise<void> {
    if (this.down_) throw new Error(`a ${this.down_.input} is already down`);
    // Booked BEFORE the call: if the press reached the browser but its ack
    // timed out, releaseAll must still lift it.
    this.down_ = { input, at: p };
    if (input === "touch") await this.touchEvent("touchStart", p);
    else await this.mouseEvent(input, "mousePressed", p, true);
  }

  /** Move the pointer that is down to `p`. */
  async moveTo(p: ClientPoint): Promise<void> {
    const d = this.down_;
    if (!d) throw new Error("moveTo: nothing is down");
    d.at = p;
    if (d.input === "touch") await this.touchEvent("touchMove", p);
    else await this.mouseEvent(d.input, "mouseMoved", p, true);
  }

  /** Lift the pointer that is down, where it is: a button release, a pen lifted, a finger lifted. */
  async lift(): Promise<void> {
    const d = this.down_;
    if (!d) return;
    this.down_ = null;
    if (d.input === "touch") await this.touchEvent("touchEnd");
    else await this.mouseEvent(d.input, "mouseReleased", d.at, false);
  }

  /**
   * End whatever is down the way an interrupted gesture ends: a finger is
   * CANCELLED (the system took it), a mouse or pen is released where it is.
   */
  async releaseAll(): Promise<void> {
    const d = this.down_;
    if (!d) return;
    this.down_ = null;
    if (d.input === "touch") await this.touchEvent("touchCancel");
    else await this.mouseEvent(d.input, "mouseReleased", d.at, false);
  }

  private async liftAfter(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } finally {
      // A gesture that threw half-way still ends with the pointer up. If the
      // lift itself was refused, a finger is cancelled instead (a mouse or pen
      // release has no second form to try).
      const d = this.down_;
      try {
        await this.lift();
      } catch {
        if (d?.input === "touch") await this.touchEvent("touchCancel").catch(() => undefined);
      }
    }
  }

  /** A tap: approach (mouse / pen), contact, hold `holdMs` (default 60, a hand's click), lift. */
  async tap(input: PointerInput, p: ClientPoint, opts: { holdMs?: number; whileHeld?: WhileHeld } = {}): Promise<void> {
    await this.approach(input, p);
    await this.press(input, p);
    await this.liftAfter(async () => {
      await this.page.waitForTimeout(opts.holdMs ?? 60);
      if (opts.whileHeld) await opts.whileHeld();
    });
  }

  /**
   * A drag: approach, contact at `from`, hold 60 ms, move in `steps` (default
   * 12) steps of `stepMs` (default 16, one frame) to `to`, stay still 60 ms
   * (so a finger does not fling), sample `whileHeld`, lift at `to`.
   */
  async drag(
    input: PointerInput,
    from: ClientPoint,
    to: ClientPoint,
    opts: { steps?: number; stepMs?: number; whileHeld?: WhileHeld } = {},
  ): Promise<void> {
    const steps = Math.max(1, opts.steps ?? 12);
    await this.approach(input, from);
    await this.press(input, from);
    await this.liftAfter(async () => {
      await this.page.waitForTimeout(60);
      for (let i = 1; i <= steps; i++) {
        await this.moveTo({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps });
        await this.page.waitForTimeout(opts.stepMs ?? 16);
      }
      await this.page.waitForTimeout(60);
      if (opts.whileHeld) await opts.whileHeld();
    });
  }

  /** A long press: approach, contact, hold still `holdMs` (default 1000 -- past any long-press timeout), sample, lift. */
  async longPress(input: PointerInput, p: ClientPoint, opts: { holdMs?: number; whileHeld?: WhileHeld } = {}): Promise<void> {
    await this.approach(input, p);
    await this.press(input, p);
    await this.liftAfter(async () => {
      await this.page.waitForTimeout(opts.holdMs ?? 1000);
      if (opts.whileHeld) await opts.whileHeld();
    });
  }
}

// ---------------------------------------------------------------------------
// The input recorder (passive, listen-only)
// ---------------------------------------------------------------------------

/** The window property the recorder lives under (a test global, not an app one). */
const LOG_KEY = "__touchPenInputLog";

/** Every DOM event type the recorder counts. */
export const LOGGED_EVENTS = [
  "pointerdown",
  "pointermove",
  "pointerup",
  "pointercancel",
  "gotpointercapture",
  "lostpointercapture",
  "touchstart",
  "touchmove",
  "touchend",
  "touchcancel",
  "mousedown",
  "mousemove",
  "mouseup",
  "click",
  "dblclick",
  "auxclick",
  "contextmenu",
  "wheel",
  "scroll",
  "dragstart",
  "selectstart",
] as const;

/** What reached the page while the log ran. */
export interface InputLog {
  /** Per event type (every type in LOGGED_EVENTS, 0 when none came). */
  counts: Record<string, number>;
  /** Distinct `pointerType`s on the pointer events. */
  pointerTypes: string[];
  /** Mouse events Chromium marked as coming from touch (`sourceCapabilities.firesTouchEvents`). */
  mouseFromTouch: number;
  /** The first pointerdown: what it landed on, its type and buttons. */
  firstDown: { target: string; pointerType: string; button: number; buttons: number } | null;
  /** Each contextmenu: its button, whether it came from touch, its target, and whether something prevented its default. */
  contextMenus: Array<{ button: number; fromTouch: boolean; target: string; prevented: boolean }>;
  /** What scrolled natively (scroll events, by target). */
  scrolled: string[];
  /** Pointer capture: totals, and what still holds a pointer the gesture used. */
  capture: { got: number; lost: number; stillCaptured: string[] };
}

/** Start (or restart) the recorder: counts from zero. */
export async function startInputLog(page: Page): Promise<void> {
  await bounded(
    "start the input log",
    page.evaluate(
      ({ key, types }) => {
        type Rec = {
          off: () => void;
          read: () => unknown;
        };
        const w = window as unknown as Record<string, Rec | undefined>;
        w[key]?.off();

        const describe = (t: EventTarget | null): string => {
          if (t === window) return "window";
          if (t === document) return "document";
          if (!(t instanceof Element)) return String(t);
          const data = Array.from(t.attributes)
            .map((a) => a.name)
            .find((n) => n.startsWith("data-"));
          const inGrid = t.closest("[data-grid-area]") !== null && !t.hasAttribute("data-grid-area");
          return `${t.tagName.toLowerCase()}${t.id ? `#${t.id}` : ""}${data ? `[${data}]` : ""}${inGrid ? " in [data-grid-area]" : ""}`;
        };
        const fromTouch = (e: Event): boolean =>
          (e as Event & { sourceCapabilities?: { firesTouchEvents?: boolean } | null }).sourceCapabilities?.firesTouchEvents === true;

        const counts: Record<string, number> = {};
        for (const t of types) counts[t] = 0;
        const pointerTypes = new Set<string>();
        const pointerIds = new Set<number>();
        let mouseFromTouch = 0;
        let firstDown: { target: string; pointerType: string; button: number; buttons: number } | null = null;
        const contextEvents: Array<{ e: MouseEvent; fromTouch: boolean; target: string }> = [];
        const scrolled = new Set<string>();
        const gotById = new Map<number, number>();
        const lostById = new Map<number, number>();
        const capturedBy = new Map<number, Set<Element>>();

        const on = (e: Event): void => {
          counts[e.type] = (counts[e.type] ?? 0) + 1;
          if (e.type.startsWith("pointer") || e.type.endsWith("pointercapture")) {
            const pe = e as PointerEvent;
            if (pe.pointerType) pointerTypes.add(pe.pointerType);
            if (typeof pe.pointerId === "number") pointerIds.add(pe.pointerId);
          }
          switch (e.type) {
            case "pointerdown": {
              const pe = e as PointerEvent;
              if (firstDown === null) {
                firstDown = { target: describe(e.target), pointerType: pe.pointerType, button: pe.button, buttons: pe.buttons };
              }
              break;
            }
            case "gotpointercapture": {
              const pe = e as PointerEvent;
              gotById.set(pe.pointerId, (gotById.get(pe.pointerId) ?? 0) + 1);
              if (e.target instanceof Element) {
                const set = capturedBy.get(pe.pointerId) ?? new Set<Element>();
                set.add(e.target);
                capturedBy.set(pe.pointerId, set);
              }
              break;
            }
            case "lostpointercapture": {
              const pe = e as PointerEvent;
              lostById.set(pe.pointerId, (lostById.get(pe.pointerId) ?? 0) + 1);
              break;
            }
            case "contextmenu":
              contextEvents.push({ e: e as MouseEvent, fromTouch: fromTouch(e), target: describe(e.target) });
              break;
            case "scroll":
              scrolled.add(describe(e.target));
              break;
            default:
              break;
          }
          if (
            (e.type.startsWith("mouse") || e.type === "click" || e.type === "dblclick" || e.type === "auxclick" || e.type === "contextmenu") &&
            fromTouch(e)
          ) {
            mouseFromTouch += 1;
          }
        };

        // PASSIVE and capture-phase: the recorder sees every event first and
        // can never cancel one (a passive listener's preventDefault is ignored,
        // and this one never calls it anyway).
        for (const t of types) window.addEventListener(t, on, { capture: true, passive: true });

        w[key] = {
          off: () => {
            for (const t of types) window.removeEventListener(t, on, { capture: true });
          },
          read: () => {
            const stillCaptured: string[] = [];
            for (const id of pointerIds) {
              const got = gotById.get(id) ?? 0;
              const lost = lostById.get(id) ?? 0;
              if (got > lost) stillCaptured.push(`pointer ${id}: gotpointercapture ${got}, lostpointercapture ${lost}`);
              // Whatever the events said, ask the elements themselves -- every
              // element, not only the ones whose got event was seen.
              for (const el of Array.from(document.querySelectorAll("*"))) {
                let has = false;
                try {
                  has = el.hasPointerCapture(id);
                } catch {
                  has = false;
                }
                if (has) stillCaptured.push(`${describe(el)} still has pointer capture of pointer ${id}`);
              }
            }
            let got = 0;
            for (const n of gotById.values()) got += n;
            let lost = 0;
            for (const n of lostById.values()) lost += n;
            return {
              counts: { ...counts },
              pointerTypes: [...pointerTypes],
              mouseFromTouch,
              firstDown,
              contextMenus: contextEvents.map((c) => ({
                button: c.e.button,
                fromTouch: c.fromTouch,
                target: c.target,
                // Read AFTER dispatch: the final answer of every listener.
                prevented: c.e.defaultPrevented,
              })),
              scrolled: [...scrolled],
              capture: { got, lost, stillCaptured },
            };
          },
        };
      },
      { key: LOG_KEY, types: [...LOGGED_EVENTS] },
    ),
    15_000,
  );
}

/** What reached the page since `startInputLog`. Throws when the log was never started. */
export async function readInputLog(page: Page): Promise<InputLog> {
  return bounded(
    "read the input log",
    page.evaluate((key) => {
      const rec = (window as unknown as Record<string, { read: () => unknown } | undefined>)[key];
      if (!rec) throw new Error("the input log was never started (startInputLog)");
      return rec.read() as InputLog;
    }, LOG_KEY),
    15_000,
  );
}

/** Remove the recorder's listeners (idempotent). */
export async function stopInputLog(page: Page): Promise<void> {
  await bounded(
    "stop the input log",
    page.evaluate((key) => {
      const w = window as unknown as Record<string, { off: () => void } | undefined>;
      w[key]?.off();
      delete w[key];
    }, LOG_KEY),
    15_000,
  );
}

/** One line of what reached the page, for the table. */
export function summariseEvents(log: InputLog): string {
  const c = (k: string): number => log.counts[k] ?? 0;
  const list = (keys: string[], strip: string): string =>
    keys
      .filter((k) => c(k) > 0)
      .map((k) => `${k.replace(strip, "") || k} ${c(k)}`)
      .join(", ");
  const parts: string[] = [];
  const ptr = list(["pointerdown", "pointermove", "pointerup", "pointercancel"], "pointer");
  if (ptr) parts.push(`pointer(${log.pointerTypes.join("/") || "?"}): ${ptr}`);
  if (c("gotpointercapture") + c("lostpointercapture") > 0) {
    parts.push(`capture got ${c("gotpointercapture")} / lost ${c("lostpointercapture")}`);
  }
  const touch = list(["touchstart", "touchmove", "touchend", "touchcancel"], "touch");
  if (touch) parts.push(`touch: ${touch}`);
  const mouse = list(["mousemove", "mousedown", "mouseup", "click", "dblclick", "auxclick"], "mouse");
  if (mouse) parts.push(`mouse: ${mouse}${log.mouseFromTouch > 0 ? ` (${log.mouseFromTouch} from touch)` : ""}`);
  if (c("contextmenu") > 0) {
    const how = log.contextMenus.map((m) => `button ${m.button}, ${m.prevented ? "prevented" : "NOT prevented"}`).join("; ");
    parts.push(`contextmenu ${c("contextmenu")} (${how})`);
  }
  if (c("wheel") > 0) parts.push(`wheel ${c("wheel")}`);
  if (c("scroll") > 0) parts.push(`native scroll of ${log.scrolled.join(", ")}`);
  if (c("dragstart") > 0) parts.push(`dragstart ${c("dragstart")}`);
  if (c("selectstart") > 0) parts.push(`selectstart ${c("selectstart")}`);
  return parts.length > 0 ? parts.join(" | ") : "no event reached the page";
}

// ---------------------------------------------------------------------------
// The product's own answers
// ---------------------------------------------------------------------------

/** A boolean query exported by an app module, read from the instance the app loaded. */
export interface ModuleProbe {
  /** How the table names it. */
  name: string;
  /** The module's served path ("/src/..." or "/extensions/..."). */
  mod: string;
  /** The exported, argument-less function that answers. */
  fn: string;
}

/**
 * The product's press sessions -- its pointer capture. Each is a window
 * listener set armed at the press and torn down at the release (or Escape, or
 * the next press). One still armed after the pointer was lifted is a stuck
 * pointer, whatever the input was.
 */
export const POINTER_HOLDERS: readonly ModuleProbe[] = [
  { name: "Core cell press", mod: "/src/core/lib/cellPressRelease.ts", fn: "isCellPressHeld" },
  { name: "Core floating move/resize", mod: "/src/core/lib/objectHover.ts", fn: "isFloatingGestureActive" },
  { name: "content-gesture pointer", mod: "/src/api/gridOverlays.ts", fn: "isContentGestureHeld" },
  { name: "floating button press", mod: "/extensions/Controls/lib/buttonPress.ts", fn: "isFloatingButtonPressActive" },
  { name: "pivot chrome press", mod: "/extensions/Pivot/lib/pivotChromePress.ts", fn: "isPivotChromePressActive" },
  { name: "chart button press", mod: "/extensions/Charts/lib/chartButtonSession.ts", fn: "isChartButtonPressActive" },
  { name: "slicer item drag", mod: "/extensions/Slicer/lib/slicerItemDrag.ts", fn: "isSlicerContentGestureActive" },
  { name: "timeline range drag", mod: "/extensions/TimelineSlicer/lib/timelineRangeDrag.ts", fn: "isTimelineContentGestureActive" },
];

/** The families' own "is my menu open" answers. */
export const MENU_PROBES: readonly ModuleProbe[] = [
  { name: "slicer menu", mod: "/extensions/Slicer/handlers/slicerContextMenu.ts", fn: "isSlicerContextMenuOpen" },
  { name: "timeline menu", mod: "/extensions/TimelineSlicer/lib/timelineMenuState.ts", fn: "isTimelineContextMenuOpen" },
  { name: "grip menu", mod: "/src/api/objectPosition.ts", fn: "isObjectGripMenuOpen" },
  { name: "chart menu", mod: "/extensions/Charts/lib/chartMenuState.ts", fn: "isChartMenuOpen" },
  { name: "control menu", mod: "/extensions/Controls/lib/controlMenuState.ts", fn: "isControlMenuOpen" },
  { name: "pivot box menu", mod: "/extensions/Pivot/lib/pivotVisualMenuState.ts", fn: "isPivotBoxMenuOpen" },
];

/** A selection click still landing its undo step (async; settles on its own). */
export const LANDING_PROBES: readonly ModuleProbe[] = [
  { name: "slicer selection landing", mod: "/extensions/Slicer/lib/slicerStore.ts", fn: "isSlicerGestureLanding" },
  { name: "timeline selection landing", mod: "/extensions/TimelineSlicer/lib/timelineSlicerStore.ts", fn: "isTimelineGestureLanding" },
];

/**
 * Ask every probe. A module that does not export its function THROWS -- a
 * probe that cannot answer must never read as "false" (nothing held), which
 * is exactly the answer a stuck-pointer check would then give for free.
 */
export async function readProbes(page: Page, probes: readonly ModuleProbe[]): Promise<Record<string, boolean>> {
  await installAppImport(page);
  return bounded(
    "read the product's probes",
    page.evaluate(async (list) => {
      const w = window as unknown as { __appImport: (m: string) => Promise<Record<string, unknown>> };
      const out: Record<string, boolean> = {};
      for (const p of list) {
        const m = await w.__appImport(p.mod);
        const f = m[p.fn];
        if (typeof f !== "function") throw new Error(`${p.mod} exports no function "${p.fn}": the probe "${p.name}" is blind`);
        out[p.name] = (f as () => unknown)() === true;
      }
      return out;
    }, [...probes]),
    15_000,
  );
}

/** The names of the product's press sessions armed right now. */
export async function heldPointers(page: Page): Promise<string[]> {
  const r = await readProbes(page, POINTER_HOLDERS);
  return Object.keys(r).filter((k) => r[k]);
}

/**
 * The press sessions still armed once the pointer has been up for a while:
 * polls until none is, or `ms` passed, and returns what is still armed then.
 */
export async function heldAfterLift(page: Page, ms = 5_000): Promise<string[]> {
  const deadline = Date.now() + ms;
  let held = await heldPointers(page);
  while (held.length > 0 && Date.now() < deadline) {
    await page.waitForTimeout(150);
    held = await heldPointers(page);
  }
  return held;
}

/** Wait until no selection click is landing (up to `ms`); returns what is STILL landing then. */
export async function settleLanding(page: Page, ms = 10_000): Promise<string[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const r = await readProbes(page, LANDING_PROBES);
    const landing = Object.keys(r).filter((k) => r[k]);
    if (landing.length === 0 || Date.now() >= deadline) return landing;
    await page.waitForTimeout(150);
  }
}

/** Every menu open now: the families' answers, plus the visible `[role="menu"]` count in the DOM. */
export async function openMenus(page: Page): Promise<string[]> {
  const r = await readProbes(page, MENU_PROBES);
  const named = Object.keys(r).filter((k) => r[k]);
  const dom = await bounded(
    "count the menus in the DOM",
    page.evaluate(
      () =>
        Array.from(document.querySelectorAll('[role="menu"]')).filter((m) => {
          const b = (m as HTMLElement).getBoundingClientRect();
          return b.width > 0 && b.height > 0;
        }).length,
    ),
    15_000,
  );
  return dom > 0 ? [...named, `${dom} [role=menu] in the DOM`] : named;
}

// ---------------------------------------------------------------------------
// Where a gesture lands, and the machine it runs on
// ---------------------------------------------------------------------------

/** What is under a CLIENT point, and the touch-action chain above it. */
export interface PointTarget {
  element: string;
  /** "none (...)" when some element up the chain says none; "auto (...)" when nothing sets it. */
  touchAction: string;
  /** Whether the point is on the grid area (Core's input door). */
  onGrid: boolean;
}

export async function targetAt(page: Page, p: ClientPoint): Promise<PointTarget> {
  return bounded(
    "describe the target",
    page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return { element: "<nothing under the point>", touchAction: "?", onGrid: false };
      const describe = (t: Element): string => {
        const data = Array.from(t.attributes)
          .map((a) => a.name)
          .find((n) => n.startsWith("data-"));
        return `${t.tagName.toLowerCase()}${t.id ? `#${t.id}` : ""}${data ? `[${data}]` : ""}`;
      };
      const chain: string[] = [];
      let effective = "auto";
      for (let n: Element | null = el; n; n = n.parentElement) {
        const ta = getComputedStyle(n).touchAction;
        if (ta && ta !== "auto") {
          chain.push(`${describe(n)}: ${ta}`);
          if (ta === "none") effective = "none";
          else if (effective === "auto") effective = ta;
        }
      }
      const area = el.closest("[data-grid-area]");
      return {
        element: `${describe(el)}${area && area !== el ? " in [data-grid-area]" : ""}`,
        touchAction: chain.length > 0 ? `${effective} (${chain.join("; ")})` : "auto (nothing up to <html> sets touch-action)",
        onGrid: area !== null,
      };
    }, p),
    15_000,
  );
}

/** What this machine and WebView advertise about touch (recorded, never changed). */
export interface TouchEnvironment {
  userAgent: string;
  maxTouchPoints: number;
  /** `"ontouchstart" in window`. */
  touchEventsExposed: boolean;
  anyPointerCoarse: boolean;
  anyPointerFine: boolean;
  anyHover: boolean;
  devicePixelRatio: number;
  /** >1 means a back entry exists, so a swipe could navigate. */
  historyLength: number;
  viewport: { width: number; height: number };
}

export async function touchEnvironment(page: Page): Promise<TouchEnvironment> {
  return bounded(
    "read the touch environment",
    page.evaluate(() => ({
      userAgent: navigator.userAgent,
      maxTouchPoints: navigator.maxTouchPoints,
      touchEventsExposed: "ontouchstart" in window,
      anyPointerCoarse: matchMedia("(any-pointer: coarse)").matches,
      anyPointerFine: matchMedia("(any-pointer: fine)").matches,
      anyHover: matchMedia("(any-hover: hover)").matches,
      devicePixelRatio: window.devicePixelRatio,
      historyLength: history.length,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    })),
    15_000,
  );
}

/** The window property a test marks the page with (a reload or navigation drops it). */
const PAGE_MARK_KEY = "__touchPenPageMark";

/** Mark the page; `pageAlive` later tells whether this very document survived. */
export async function markPage(page: Page): Promise<string> {
  const token = `tp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await bounded(
    "mark the page",
    page.evaluate(({ key, token }) => {
      (window as unknown as Record<string, unknown>)[key] = token;
    }, { key: PAGE_MARK_KEY, token }),
    15_000,
  );
  return token;
}

/**
 * Whether the SAME document is still loaded (the mark survived) and the
 * spreadsheet is still mounted. Never throws: a page that cannot be evaluated
 * at all (destroyed context, navigation) answers false on both.
 */
export async function pageAlive(page: Page, token: string): Promise<{ marked: boolean; mounted: boolean; detail: string }> {
  try {
    const r = await bounded(
      "is the page alive?",
      page.evaluate(({ key, token }) => {
        const w = window as unknown as Record<string, unknown>;
        return {
          marked: w[key] === token,
          mounted: document.querySelector("[data-focus-container='spreadsheet']") !== null,
          url: location.href,
        };
      }, { key: PAGE_MARK_KEY, token }),
      15_000,
    );
    return { marked: r.marked, mounted: r.mounted, detail: r.url };
  } catch (e) {
    return { marked: false, mounted: false, detail: `the page could not be evaluated: ${String(e).slice(0, 300)}` };
  }
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/** One measured gesture with one input. */
export interface MeasureRow {
  /** The test's id ("TP-2"). */
  id: string;
  surface: string;
  gesture: string;
  input: PointerInput;
  /** What is under the gesture's start point, and its touch-action chain. */
  target: string;
  /** What the product did ("moved (+64, +32)", "nothing", ...). */
  happened: string;
  /** What reached the page (summariseEvents). */
  events: string;
  /** The press sessions armed while the pointer was still down ("(not sampled)" for a tap). */
  heldMidGesture: string;
  /** The press sessions still armed after the lift -- must be empty. */
  heldAfter: string[];
  /** Pointer capture still held after the lift -- must be empty. */
  captureAfter: string[];
  /** Uncaught page errors during the measurement (recorded, not asserted). */
  pageErrors: string[];
  /** CONTROL / PROBE TEETH failures, a selection still landing, and the like. */
  notes: string[];
  /** The raw before/after reads, for whoever needs more than the line. */
  facts: Record<string, unknown>;
  /** The measurement itself could not be taken (a harness failure), or null. */
  error: string | null;
  measuredAt: string;
}

const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** The rows as a markdown table. */
export function renderMeasureTable(rows: readonly MeasureRow[]): string {
  const head =
    "| id | surface | gesture | input | what happened | events that reached the page | armed while held | still held after the lift | target (touch-action) | notes |\n" +
    "|---|---|---|---|---|---|---|---|---|---|";
  const body = rows.map((r) => {
    const stuck = [...r.heldAfter, ...r.captureAfter];
    const notes = [
      ...(r.error ? [`NOT MEASURED: ${r.error}`] : []),
      ...r.notes,
      ...r.pageErrors.map((e) => `page error: ${e}`),
    ];
    return `| ${[
      r.id,
      r.surface,
      r.gesture,
      r.input,
      r.error ? "-" : r.happened,
      r.events,
      r.heldMidGesture,
      stuck.length > 0 ? `STUCK: ${stuck.join("; ")}` : "nothing",
      r.target,
      notes.join("; "),
    ]
      .map((v) => cell(String(v)))
      .join(" | ")} |`;
  });
  return [head, ...body].join("\n");
}

/** The machine, as a short markdown list. */
export function renderEnvironment(env: TouchEnvironment | null): string {
  if (!env) return "- environment: not read";
  return [
    `- user agent: ${env.userAgent}`,
    `- navigator.maxTouchPoints: ${env.maxTouchPoints}; "ontouchstart" in window: ${env.touchEventsExposed}`,
    `- (any-pointer: coarse) ${env.anyPointerCoarse}; (any-pointer: fine) ${env.anyPointerFine}; (any-hover: hover) ${env.anyHover}`,
    `- devicePixelRatio ${env.devicePixelRatio}; viewport ${env.viewport.width} x ${env.viewport.height}; history.length ${env.historyLength}`,
  ].join("\n");
}

/** One test's measurement, as written to disk. */
export interface MeasurementFile {
  title: string;
  measuredAt: string;
  env: TouchEnvironment | null;
  rows: MeasureRow[];
}

/** File-name-safe form of a test title. */
export function measurementSlug(title: string): string {
  return title.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90);
}

/** Write one test's rows to `<dir>/<slug>.json` (overwriting that test's previous run). */
export function writeMeasurement(dir: string, file: MeasurementFile): string {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${measurementSlug(file.title)}.json`);
  fs.writeFileSync(target, JSON.stringify(file, null, 2));
  return target;
}

/**
 * Compose every `<dir>/*.json` into `<dir>/TABLE.md`, ordered by test id. A
 * file measured more than 3 hours before the newest one is marked STALE: it is
 * a test that did not run this time, and its rows are from an earlier run.
 */
export function composeMeasurementTable(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const files: MeasurementFile[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      files.push(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as MeasurementFile);
    } catch {
      // A half-written file from an interrupted run: leave it out, say nothing worse.
    }
  }
  if (files.length === 0) return null;
  const idNum = (t: string): number => {
    const m = /TP-(\d+)/.exec(t);
    return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
  };
  files.sort((a, b) => idNum(a.title) - idNum(b.title) || a.title.localeCompare(b.title));
  const newest = Math.max(...files.map((f) => Date.parse(f.measuredAt) || 0));
  const out: string[] = [
    "# Touch and pen, measured (journeys/touch-pen-measure.spec.ts)",
    "",
    `Composed ${new Date().toISOString()} from ${files.length} test file(s). The mouse rows are the CONTROL (the same CDP driver).`,
    "",
    renderEnvironment(files.find((f) => f.env !== null)?.env ?? null),
    "",
  ];
  for (const f of files) {
    const stale = newest - (Date.parse(f.measuredAt) || 0) > 3 * 60 * 60 * 1000;
    out.push(`## ${f.title}${stale ? " -- STALE (an earlier run; this test did not run this time)" : ""}`, "");
    out.push(`measured ${f.measuredAt}`, "");
    out.push(renderMeasureTable(f.rows), "");
  }
  const table = out.join("\n");
  fs.writeFileSync(path.join(dir, "TABLE.md"), table);
  return table;
}
