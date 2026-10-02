//! FILENAME: app/extensions/Controls/__tests__/resizeKeepsRegion.test.ts
// PURPOSE: BUG-0268 -- a control resized by a Core handle keeps the NEW
//          rectangle in its published GridRegion, whatever order the backend
//          serves the resize's geometry WRITE and the renderer's property READ.
// CONTEXT: Found live 2026-09-30 (e2e run 9c, moving-objects step 9): a canvas
//          shape 160 x 96, its right-edge handle dragged +64. `get_all_controls`
//          read width 224; `getGridRegions()` read 160 right after the release,
//          and still 160 after opening the Canvas tab and after Arrange > Lock,
//          so the padlock (drawn inside the region's top-right corner) sat at
//          the OLD edge. The sequence, driven here through the REAL activate()
//          and the real window events Core dispatches:
//            1. `floatingObject:resizePreview` then `floatingObject:resizeComplete`
//               (overlayResizeHandlers.ts). Controls' handler puts 224 in the
//               store and the region, INVALIDATES the renderer caches, starts
//               persisting (`set_control_geometry`, async) and asks for a paint.
//            2. The paint re-reads the invalidated control
//               (`resolve_control_properties`) and writes the resolved width
//               BACK into the store (the write-back exists for a formula-driven
//               size).
//            3. Tauri dispatches commands on a thread pool, so nothing ordered
//               the read after the write: served first, it returned 160, and
//               the write-back put the store -- and the region every reader
//               uses -- back to 160 while the backend held 224. Nothing read it
//               again (the cache was fresh), so it stayed wrong.
//          The fake backend below SERVES a read when it arrives and DELIVERS it
//          when the test says so, and applies a write only when released, so
//          each interleaving is a line of the test, not a timing accident.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { loadHarness, settle, type Loader } from "../../ModelMenu/__tests__/lifecycleHarness";

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  listenForEvent: vi.fn(async () => () => {}),
  listenTauriEvent: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async (cmd: string) => {
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

const CONTROLS: Loader = () => import("..");

// ---------------------------------------------------------------------------
// The fake backend: one control at (row 2, col 1) on sheet 0.
// ---------------------------------------------------------------------------

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const START: Rect = { x: 64, y: 64, width: 160, height: 96 };
const RESIZED: Rect = { x: 64, y: 64, width: 224, height: 96 };
const ANCHOR = { sheetIndex: 0, row: 2, col: 1 };
const ID = `control-${ANCHOR.sheetIndex}-${ANCHOR.row}-${ANCHOR.col}`;

let controlType: "shape" | "button" = "shape";
/** What the backend holds. */
let backend: Rect = { ...START };
/** When false, reads are delivered and writes applied only when the test releases them. */
let autoServe = true;

interface HeldRead {
  kind: "read";
  /** The width the backend SERVED (at arrival): the value the read will deliver. */
  servedWidth: number;
  deliver: () => void;
}
interface HeldWrite {
  kind: "write";
  land: () => void;
}
let held: Array<HeldRead | HeldWrite> = [];
let readsIssued = 0;
/** The width each DELIVERED read carried, in delivery order. */
let deliveredWidths: number[] = [];
let writesIssued = 0;
/** Reads issued while a geometry write was on its way (never landed yet). */
let readsUnderWrite = 0;
let writesInFlight = 0;

function props(): Record<string, { valueType: "static"; value: string }> {
  const s = (v: number | string) => ({ valueType: "static" as const, value: String(v) });
  return {
    x: s(backend.x),
    y: s(backend.y),
    width: s(backend.width),
    height: s(backend.height),
    ...(controlType === "button" ? { embedded: s("false"), text: s("Run") } : { shapeType: s("rectangle") }),
  };
}

function resolved(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(props())) out[k] = v.value;
  return out;
}

async function invokeBackend(command: string, args?: unknown): Promise<unknown> {
  switch (command) {
    case "get_all_controls":
      return [{ ...ANCHOR, metadata: { controlType, properties: props() } }];
    case "resolve_control_properties": {
      readsIssued += 1;
      if (writesInFlight > 0) readsUnderWrite += 1;
      const value = resolved();
      if (autoServe) {
        deliveredWidths.push(Number(value.width));
        return value;
      }
      return new Promise((resolve) => {
        held.push({
          kind: "read",
          servedWidth: Number(value.width),
          deliver: () => {
            deliveredWidths.push(Number(value.width));
            resolve(value);
          },
        });
      });
    }
    case "set_control_geometry": {
      writesIssued += 1;
      writesInFlight += 1;
      const changes = (args as { changes: Rect[] }).changes;
      const apply = () => {
        const c = changes[0];
        backend = { x: c.x, y: c.y, width: c.width, height: c.height };
        writesInFlight -= 1;
      };
      if (autoServe) {
        apply();
        return changes.length;
      }
      return new Promise((resolve) => {
        held.push({
          kind: "write",
          land: () => {
            apply();
            resolve(changes.length);
          },
        });
      });
    }
    default:
      return null;
  }
}

function takeHeld<K extends "read" | "write">(kind: K): Extract<HeldRead | HeldWrite, { kind: K }> {
  const i = held.findIndex((x) => x.kind === kind);
  if (i < 0) throw new Error(`no held ${kind} (held: ${held.map((x) => x.kind).join(", ") || "none"})`);
  const [x] = held.splice(i, 1);
  return x as Extract<HeldRead | HeldWrite, { kind: K }>;
}

// ---------------------------------------------------------------------------
// The live modules (loaded after the harness's module reset).
// ---------------------------------------------------------------------------

let ext: Awaited<ReturnType<typeof loadHarness>>["ext"];
let overlays: typeof import("@api/gridOverlays");
let shapes: typeof import("../Shape/shapeRenderer");
let buttons: typeof import("../Button/floatingRenderer");
let store: typeof import("../lib/floatingStore");

/** The control's published region (what Core's chrome, the padlock and every hit test read). */
function region() {
  const r = overlays.getGridRegions().find((g) => g.id === ID);
  if (!r?.floating) throw new Error("the control has no published region");
  return r;
}

/** A canvas context that answers every 2D call. */
function fakeCtx(): CanvasRenderingContext2D {
  const target: Record<string, unknown> = { globalAlpha: 1 };
  return new Proxy(target, {
    get: (obj, prop) => (prop in obj ? obj[prop as string] : () => undefined),
    set: (obj, prop, value) => {
      obj[prop as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

/** One paint of the control, as the grid's render pass does it (Controls' dispatcher routes by type). */
function paint(): void {
  const r = region();
  const overlayCtx = {
    ctx: fakeCtx(),
    canvasWidth: 2000,
    canvasHeight: 2000,
    config: { rowHeaderWidth: 50, colHeaderHeight: 24 },
    viewport: { scrollX: 0, scrollY: 0 },
    region: r,
  } as never;
  if (controlType === "shape") shapes.renderFloatingShape(overlayCtx);
  else buttons.renderFloatingButton(overlayCtx);
}

/** Paint and let the fetch it starts finish, a few frames (the grid redraws on requestOverlayRedraw). */
async function paintUntilQuiet(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    paint();
    await settle();
  }
}

/** What Core dispatches for a right-edge handle drag from 160 to 224 (overlayResizeHandlers.ts). */
function resizeByRightEdge(phase: "preview" | "complete"): void {
  const r = region();
  window.dispatchEvent(
    new CustomEvent(phase === "preview" ? "floatingObject:resizePreview" : "floatingObject:resizeComplete", {
      detail: { regionId: ID, regionType: "floating-control", data: r.data, ...RESIZED },
    }),
  );
}

async function reloadControl(type: "shape" | "button"): Promise<void> {
  // Whatever an earlier (failed) test left held lands and is delivered first,
  // so no fetch or write of it outlives the test that started it.
  autoServe = true;
  for (const x of held.splice(0)) (x.kind === "read" ? x.deliver : x.land)();
  await settle();
  controlType = type;
  backend = { ...START };
  // The store holds the control as a load from the backend leaves it (the
  // activation's own load put the shape there; the button case swaps it).
  store.removeFloatingControlsForSheet(ANCHOR.sheetIndex);
  store.addFloatingControl({ id: ID, ...ANCHOR, ...START, controlType: type });
  store.syncFloatingControlRegions();
  shapes.invalidateAllShapeCaches();
  buttons.invalidateAllFloatingButtonCaches();
  await paintUntilQuiet();
  readsIssued = 0;
  deliveredWidths = [];
  writesIssued = 0;
  readsUnderWrite = 0;
  writesInFlight = 0;
  expect(region().floating, "precondition: the control starts 160 wide").toEqual(START);
}

beforeAll(async () => {
  const harness = await loadHarness(CONTROLS, { invokeBackend });
  ext = harness.ext;
  await ext.activate(harness.context);
  await settle();
  overlays = await import("@api/gridOverlays");
  // The activation loaded the control from the fake backend (loadFloatingControls).
  expect(overlays.getGridRegions().find((g) => g.id === ID)?.floating, "the activation's load published the control").toEqual(START);
  shapes = await import("../Shape/shapeRenderer");
  buttons = await import("../Button/floatingRenderer");
  store = await import("../lib/floatingStore");
});

afterAll(async () => {
  await ext.deactivate?.();
  await settle();
});

describe.each(["shape", "button"] as const)("BUG-0268: a %s resized by a Core handle keeps its NEW region", (type) => {
  beforeEach(async () => {
    await reloadControl(type);
  });

  it("THE LIVE ORDER: the paint's read is served BEFORE the resize's write lands -- the region still ends 224 wide", async () => {
    autoServe = false;
    resizeByRightEdge("preview");
    resizeByRightEdge("complete");
    // The paint Controls asked for (GRID_REFRESH) re-reads the invalidated control.
    paint();
    await settle();
    expect(store.getFloatingControl(ID)?.width, "the handler put the new width in the store").toBe(224);
    expect(writesIssued, "the resize persisted once").toBe(1);

    // The backend serves a read before the write lands (Tauri's thread pool),
    // and it is delivered first -- the order run 9c measured.
    if (held.some((x) => x.kind === "read")) {
      const read = takeHeld("read");
      expect(read.servedWidth, "the read was served before the write landed").toBe(160);
      read.deliver();
      await settle();
      expect(region().floating?.width, "a read served before the write put the OLD width back into the region").toBe(224);
    }
    takeHeld("write").land();
    await settle();
    autoServe = true;
    for (const x of held.splice(0)) (x.kind === "read" ? x.deliver : x.land)();
    await paintUntilQuiet();

    expect(backend.width, "the backend holds the new width").toBe(224);
    expect(region().floating, "the region disagrees with the backend after a Core-handle resize (BUG-0268)").toEqual(RESIZED);
    expect(store.getFloatingControl(ID)?.width).toBe(224);
    // The superseded read is DONE AGAIN once the write landed: the renderer's
    // cache ends on what the backend holds, not on the old read.
    expect(deliveredWidths.at(-1), "the control was never re-read after the write landed").toBe(224);
  });

  it("a read that was already on its way BEFORE the resize (served 160) and delivered after the write landed changes nothing", async () => {
    autoServe = false;
    // A paint before the gesture starts a read of the old geometry.
    shapes.invalidateAllShapeCaches();
    buttons.invalidateAllFloatingButtonCaches();
    paint();
    await settle();
    const early = takeHeld("read");
    expect(early.servedWidth).toBe(160);

    resizeByRightEdge("preview");
    resizeByRightEdge("complete");
    await settle();
    takeHeld("write").land();
    await settle();
    early.deliver();
    await settle();
    autoServe = true;
    for (const x of held.splice(0)) (x.kind === "read" ? x.deliver : x.land)();
    await paintUntilQuiet();

    expect(backend.width).toBe(224);
    expect(region().floating, "a read from before the resize put the OLD width back (BUG-0268)").toEqual(RESIZED);
    expect(deliveredWidths.at(-1), "the control was never re-read after the write landed").toBe(224);
  });

  it("mid-drag: a read of the old geometry delivered between two preview frames does not snap the region back", async () => {
    autoServe = false;
    shapes.invalidateAllShapeCaches();
    buttons.invalidateAllFloatingButtonCaches();
    paint();
    await settle();
    const early = takeHeld("read");
    resizeByRightEdge("preview");
    early.deliver();
    await settle();
    expect(region().floating?.width, "a stale read snapped the region back in the middle of the drag").toBe(224);
    resizeByRightEdge("complete");
    await settle();
    autoServe = true;
    for (const x of held.splice(0)) (x.kind === "read" ? x.deliver : x.land)();
    await paintUntilQuiet();
    expect(region().floating).toEqual(RESIZED);
    expect(backend.width).toBe(224);
  });

  it("no read is ISSUED while the resize's write is on its way: the re-read waits for the write, so it converges", async () => {
    autoServe = false;
    resizeByRightEdge("preview");
    resizeByRightEdge("complete");
    await settle();
    // Several paints while the write is held: none may read under it.
    for (let i = 0; i < 3; i++) {
      paint();
      await settle();
    }
    expect(readsUnderWrite, "a renderer read the control while its geometry write was still on its way").toBe(0);
    takeHeld("write").land();
    await settle();
    autoServe = true;
    for (const x of held.splice(0)) (x.kind === "read" ? x.deliver : x.land)();
    await paintUntilQuiet();
    expect(region().floating).toEqual(RESIZED);
  });

  it("control: the write lands BEFORE the read is served -- 224 either way (the order the fix must not depend on)", async () => {
    autoServe = false;
    resizeByRightEdge("preview");
    resizeByRightEdge("complete");
    await settle();
    takeHeld("write").land();
    await settle();
    autoServe = true;
    for (const x of held.splice(0)) (x.kind === "read" ? x.deliver : x.land)();
    await paintUntilQuiet();
    expect(region().floating).toEqual(RESIZED);
    expect(backend.width).toBe(224);
  });

  it("control: a FORMULA-driven size the backend resolves (no gesture) still reaches the region", async () => {
    // Nothing about the geometry changed in the frontend: a read that returns a
    // different size is the formula's answer and is applied.
    backend = { ...START, width: 300 };
    shapes.invalidateAllShapeCaches();
    buttons.invalidateAllFloatingButtonCaches();
    await paintUntilQuiet();
    expect(region().floating?.width, "the resolved (formula) width never reached the region").toBe(300);
  });
});
