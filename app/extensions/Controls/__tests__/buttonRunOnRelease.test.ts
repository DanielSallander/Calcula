//! FILENAME: app/extensions/Controls/__tests__/buttonRunOnRelease.test.ts
// PURPOSE: A RUN-MODE floating button runs at the RELEASE inside it (BUG-0258
//          design phase 4c), driven through the REAL activate() with the real
//          window events Core dispatches for a CONTENT press
//          (`floatingObject:selected` with zone 'content' and part 'button',
//          then `floatingObject:bodyDragStart`) and a real window mouseup:
//            - the press runs NOTHING: no `button:clicked`, and the M4 click
//              path (`runFloatingButtonClick`, whose first act is asking the
//              Rust button door, `run_control_action`) is not entered;
//            - the release inside runs both, once;
//            - sliding off before the release runs nothing;
//            - a Design-Mode press (frame) selects and never runs;
//            - a press on an object's GRIP (BUG-0258 phase 5) emits no
//              `shape:clicked`, while a plain shape press still does;
//            - a press still held when the extension deactivates runs nothing.
//          Plus the source census: `handleFloatingSelected` no longer carries
//          the run, and the bodyDragStart listener starts the press.
// CONTEXT: The press module's own rules (pressed look, Escape, blur, a lost
//          release, a covering object) are pinned in
//          lib/__tests__/buttonPress.test.ts; the zone answer in
//          controlZoneAt.test.ts. The extension is activated through the
//          ModelMenu lifecycle harness (chartButtonRelease.test.ts's precedent);
//          the hit test is Core's real `topFloatingRegionAtClient` over a
//          `[data-grid-area]` box at (0, 0), zoom 1.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { loadHarness, settle, type Loader } from "../../ModelMenu/__tests__/lifecycleHarness";

const h = vi.hoisted(() => ({
  emitted: [] as unknown[][],
  backendCalls: [] as string[],
}));

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  listenForEvent: vi.fn(async () => () => {}),
  listenTauriEvent: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async (cmd: string) => {
    // The @api doors (run_control_action among them) reach the backend here,
    // not through the context's channel: recorded for the click-path probe.
    h.backendCalls.push(cmd);
    if (cmd === "get_active_sheet") return 0;
    if (cmd === "get_all_styles") return [];
    return null;
  }),
}));
vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => {}),
}));
// Core's live geometry: a worksheet at zoom 1, headers 50 x 24, no scroll.
vi.mock("../../../src/core/state/GridContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/core/state/GridContext")>()),
  getGridStateSnapshot: () => ({
    surface: "grid",
    zoom: 1,
    displayHeadings: true,
    config: { rowHeaderWidth: 50, colHeaderHeight: 24, defaultCellWidth: 100, defaultCellHeight: 24 },
    viewport: { scrollX: 0, scrollY: 0 },
    sheetContext: { activeSheetIndex: 0 },
    dimensions: { columnWidths: new Map(), rowHeights: new Map() },
  }),
}));
vi.mock("@api/events", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@api/events")>();
  return {
    ...orig,
    emitAppEvent: (...args: unknown[]) => {
      h.emitted.push(args);
      return (orig.emitAppEvent as (...a: unknown[]) => unknown)(...args);
    },
  };
});

const CONTROLS: Loader = () => import("..");

const BUTTON_ANCHOR = { sheetIndex: 0, row: 2, col: 1 };
const SHAPE_ANCHOR = { sheetIndex: 0, row: 8, col: 1 };
const BUTTON = `control-0-${BUTTON_ANCHOR.row}-${BUTTON_ANCHOR.col}`;
const SHAPE = `control-0-${SHAPE_ANCHOR.row}-${SHAPE_ANCHOR.col}`;
/** The button in sheet px; on the canvas it sits at (50 + x, 24 + y). */
const B = { x: 64, y: 64, width: 160, height: 40 };
const S = { x: 64, y: 200, width: 120, height: 80 };
const INSIDE = { x: 50 + B.x + 80, y: 24 + B.y + 20 };
const OFF = { x: INSIDE.x, y: INSIDE.y + 60 };

async function invokeBackend(command: string): Promise<unknown> {
  h.backendCalls.push(command);
  if (command === "get_all_controls") {
    const s = (v: number | string) => ({ valueType: "static" as const, value: String(v) });
    return [
      {
        ...BUTTON_ANCHOR,
        metadata: {
          controlType: "button",
          properties: { embedded: s("false"), x: s(B.x), y: s(B.y), width: s(B.width), height: s(B.height), text: s("Run") },
        },
      },
      {
        ...SHAPE_ANCHOR,
        metadata: {
          controlType: "shape",
          properties: { x: s(S.x), y: s(S.y), width: s(S.width), height: s(S.height), shapeType: s("rectangle") },
        },
      },
    ];
  }
  return null;
}

let ext: Awaited<ReturnType<typeof loadHarness>>["ext"];
let overlays: typeof import("@api/gridOverlays");
let designMode: typeof import("../lib/designMode");
let pressModule: typeof import("../lib/buttonPress");
let area: HTMLElement;

function regionOf(id: string) {
  const r = overlays.getGridRegions().find((g) => g.id === id);
  if (!r) throw new Error(`no region ${id}`);
  return r;
}

function fire(name: string, detail: Record<string, unknown>): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

/** Core's press on a floating control, as pressZone dispatches it for the zone the control answers. */
function corePress(id: string, part: string | null, at = INSIDE): void {
  const r = regionOf(id);
  const zone = overlays.resolveFloatingZone({
    region: r,
    canvasX: at.x,
    canvasY: at.y,
    row: 0,
    col: 0,
  } as never);
  const effectivePart = part ?? zone.part;
  const content = zone.kind === "content";
  if (id === BUTTON && regionOf(BUTTON).data?.movable === false && !content) {
    throw new Error("a run-mode button did not answer CONTENT (the zone registration is missing)");
  }
  fire("floatingObject:selected", {
    regionId: r.id,
    regionType: r.type,
    data: r.data,
    zone: zone.kind,
    part: effectivePart,
    canvasX: at.x,
    canvasY: at.y,
    ctrlKey: false,
    shiftKey: false,
  });
  if (content) {
    fire("floatingObject:bodyDragStart", {
      regionId: r.id,
      regionType: r.type,
      data: r.data,
      canvasX: at.x,
      canvasY: at.y,
      part: effectivePart,
      ctrlKey: false,
      shiftKey: false,
    });
  }
}

function move(at: { x: number; y: number }): void {
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: at.x, clientY: at.y, buttons: 1 }));
}

function release(at: { x: number; y: number }): void {
  window.dispatchEvent(new MouseEvent("mouseup", { clientX: at.x, clientY: at.y, button: 0 }));
}

const clicks = () => h.emitted.filter((a) => a[0] === "button:clicked");
const shapeClicks = () => h.emitted.filter((a) => a[0] === "shape:clicked");
/**
 * The click path was entered. Its first act is asking the Rust button door
 * (phase 4 of BUG-0257: `runFloatingButtonClick` -> `run_control_action`); it
 * used to be reading the button's metadata for its macro link.
 */
const clickPathRuns = () => h.backendCalls.filter((c) => c === "run_control_action").length;

beforeAll(async () => {
  area = document.createElement("div");
  area.setAttribute("data-grid-area", "");
  area.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 2000, bottom: 2000, width: 2000, height: 2000, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  document.body.appendChild(area);
  const harness = await loadHarness(CONTROLS, { invokeBackend });
  ext = harness.ext;
  await ext.activate(harness.context);
  await settle();
  overlays = await import("@api/gridOverlays");
  // The harness's grid context is inert, so the registration index.ts makes
  // (`context.grid.overlays.register`, pinned in controlZoneAt.test.ts) is
  // made here with the same zone answer, into the live registry Core reads.
  const { floatingControlZoneAt } = await import("../lib/controlZoneAt");
  overlays.registerGridOverlay({ type: "floating-control", render: () => {}, zoneAt: floatingControlZoneAt });
  designMode = await import("../lib/designMode");
  pressModule = await import("../lib/buttonPress");
  expect(regionOf(BUTTON).data?.movable, "precondition: the button is in RUN mode").toBe(false);
});

afterAll(async () => {
  await ext.deactivate?.();
  await settle();
  area.remove();
});

beforeEach(async () => {
  release({ x: -500, y: -500 });
  await settle();
  h.emitted.length = 0;
  h.backendCalls.length = 0;
});

describe("a run-mode button runs at the RELEASE inside it", () => {
  it("the PRESS runs nothing; the release inside runs the hook and the M4 click path, once", async () => {
    corePress(BUTTON, null);
    await settle();
    expect(clicks(), "button:clicked was emitted on the PRESS").toHaveLength(0);
    expect(clickPathRuns(), "the click path ran on the PRESS").toBe(0);
    expect(pressModule.isFloatingButtonPressed(BUTTON), "the button does not show pressed").toBe(true);

    release(INSIDE);
    await settle();
    // ONE run: the hook and the click path are one closure, called once.
    expect(clicks()).toHaveLength(1);
    expect(clicks()[0][1]).toEqual({ instanceId: BUTTON, x: 0, y: 0 });
    expect(clickPathRuns(), "the release did not enter the button's click path").toBeGreaterThan(0);
    expect(pressModule.isFloatingButtonPressed(BUTTON)).toBe(false);
  });

  it("SLID OFF before the release: nothing runs", async () => {
    corePress(BUTTON, null);
    move(OFF);
    release(OFF);
    await settle();
    expect(clicks(), "sliding off did not cancel the button").toHaveLength(0);
    expect(clickPathRuns()).toBe(0);
  });

  it("a `floatingObject:selected` alone (no bodyDragStart) runs nothing: the press is the content's", async () => {
    const r = regionOf(BUTTON);
    fire("floatingObject:selected", {
      regionId: r.id, regionType: r.type, data: r.data, zone: "content", part: "button",
      canvasX: INSIDE.x, canvasY: INSIDE.y, ctrlKey: false, shiftKey: false,
    });
    release(INSIDE);
    await settle();
    expect(clicks(), "handleFloatingSelected still runs a run-mode button").toHaveLength(0);
    expect(clickPathRuns()).toBe(0);
  });

  it("DESIGN MODE: the press is frame and selects; nothing runs", async () => {
    designMode.setDesignMode(true);
    await settle();
    try {
      expect(regionOf(BUTTON).data?.movable, "a Design-Mode button can move").toBe(true);
      corePress(BUTTON, null);
      release(INSIDE);
      await settle();
      expect(clicks()).toHaveLength(0);
      expect(clickPathRuns()).toBe(0);
    } finally {
      designMode.setDesignMode(false);
      await settle();
    }
  });
});

describe("a GRIP press (BUG-0258 phase 5) is a frame press that never acts", () => {
  it("a shape pressed by its grip emits no shape:clicked; pressed by its body it still does", async () => {
    corePress(SHAPE, "grip", { x: 50 + S.x + 10, y: 24 + S.y + 10 });
    await settle();
    expect(shapeClicks(), "a grip press emitted shape:clicked").toHaveLength(0);
    corePress(SHAPE, null, { x: 50 + S.x + 10, y: 24 + S.y + 10 });
    await settle();
    expect(shapeClicks(), "control: a body press on a shape emits shape:clicked").toHaveLength(1);
  });

  it("in Design Mode too", async () => {
    designMode.setDesignMode(true);
    await settle();
    try {
      corePress(SHAPE, "grip", { x: 50 + S.x + 10, y: 24 + S.y + 10 });
      await settle();
      expect(shapeClicks()).toHaveLength(0);
    } finally {
      designMode.setDesignMode(false);
      await settle();
    }
  });
});

describe("index.ts: the run moved from the press to the release (source census)", () => {
  const src = readFileSync(resolve(__dirname, "../index.ts"), "utf8");
  const code = src.replace(/\/\/.*$/gm, "");
  const selectedAt = code.indexOf("const handleFloatingSelected = (e: Event) => {");
  const selectedBody = code.slice(selectedAt, code.indexOf('window.addEventListener("floatingObject:selected", handleFloatingSelected);', selectedAt));

  it("handleFloatingSelected carries no button:clicked emit and no runFloatingButtonClick call", () => {
    expect(selectedAt, "handleFloatingSelected is gone").toBeGreaterThan(0);
    expect(selectedBody).not.toContain("button:clicked");
    expect(selectedBody).not.toContain("runFloatingButtonClick(");
  });

  it("a floatingObject:bodyDragStart listener starts the press with beginFloatingButtonPress", () => {
    const at = code.indexOf("const handleButtonPress = (e: Event) => {");
    expect(at, "the bodyDragStart press listener is gone").toBeGreaterThan(0);
    const body = code.slice(at, code.indexOf('window.addEventListener("floatingObject:bodyDragStart", handleButtonPress);', at));
    expect(body).toContain("beginFloatingButtonPress(");
    expect(body).toContain('"button:clicked"');
    expect(body).toContain("runFloatingButtonClick(");
    expect(code).toContain("cleanupFns.push(cancelFloatingButtonPress);");
  });
});

describe("deactivation", () => {
  it("a press still held when the extension deactivates runs nothing; a press AFTER it arms nothing (the bodyDragStart listener is gone)", async () => {
    // The button's region as Core last saw it: deactivation un-publishes it,
    // but Core's dispatch carries what it hit, so the events below are what a
    // press that raced the teardown would deliver.
    const r = regionOf(BUTTON);
    corePress(BUTTON, null);
    expect(pressModule.isFloatingButtonPressActive()).toBe(true);
    await ext.deactivate?.();
    await settle();
    expect(pressModule.isFloatingButtonPressActive(), "deactivation left the press held").toBe(false);
    release(INSIDE);
    await settle();
    expect(clicks()).toHaveLength(0);
    expect(clickPathRuns()).toBe(0);

    // A press after the teardown: Core's content press on the button again.
    // A listener left bound by the deactivated extension would arm it here --
    // and after a re-activation the same press would arm (and RUN) twice.
    const press = { regionId: r.id, regionType: r.type, data: r.data, canvasX: INSIDE.x, canvasY: INSIDE.y, ctrlKey: false, shiftKey: false };
    fire("floatingObject:selected", { ...press, zone: "content", part: "button" });
    fire("floatingObject:bodyDragStart", { ...press, part: "button" });
    expect(pressModule.isFloatingButtonPressActive(), "a press after deactivation armed the button (its bodyDragStart listener outlived the extension)").toBe(false);
    release(INSIDE);
    await settle();
    expect(clicks()).toHaveLength(0);
    expect(clickPathRuns()).toBe(0);
  });
});
