//! FILENAME: app/extensions/Controls/__tests__/controlBindingsWiring.test.tsx
// PURPOSE: Controls' wiring of property bindings (D-BIND, WP-D S8a), through
//          the REAL activate() over a fake backend:
//            * CELLS_UPDATED still refreshes the in-cell buttons' style cache,
//              and no longer invalidates every control or emits GRID_REFRESH
//              (a bound property is evaluated by Rust and announced);
//            * the formula-property NAMED_RANGES_CHANGED handler is gone;
//            * `onBindingsChanged` drops the paint caches of exactly the
//              controls it names (all of them on a reload) and never emits
//              GRID_REFRESH (the binding bridge's trigger: a loop);
//            * a script's `shape.setProperty("text", "=A1")` lands STATIC and
//              keeps the control's type (the door no longer hard-codes "shape");
//            * the `control` registration turns a region and a script instance
//              into `{ kind: "control", id: uid }` read from the BACKEND;
//            * a_pasted_controls_ref_is_not_the_sources: a pasted copy of a
//              bound shape (its local metadata carries the SOURCE's uid, the
//              backend re-mints on collision) has its own ref, and an fx edit
//              in the copy's Properties pane writes `Set` with the COPY's uid.
// CONTEXT: The harness of resizeKeepsRegion.test.ts (lifecycleHarness), with
//          the context's `events` replaced by a recorder so the handlers
//          Controls registers can be driven.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { loadHarness, settle, type Loader } from "../../ModelMenu/__tests__/lifecycleHarness";

// ---------------------------------------------------------------------------
// The fake backend.
// ---------------------------------------------------------------------------

interface Meta {
  controlType: string;
  uid?: string;
  properties: Record<string, { valueType: string; value: string }>;
}

const fake = vi.hoisted(() => {
  const s = {
    controls: new Map<string, Meta>(),
    nextUid: 1,
    reads: new Map<string, number>(),
    styleReads: 0,
    setProperty: [] as Array<Record<string, unknown>>,
    bindingRequests: [] as Array<Record<string, unknown>>,
    key(sheetIndex: number, row: number, col: number): string {
      return `${sheetIndex}:${row}:${col}`;
    },
    reset(): void {
      s.controls.clear();
      s.nextUid = 1;
      s.reads.clear();
      s.styleReads = 0;
      s.setProperty = [];
      s.bindingRequests = [];
    },
  };
  return s;
});

function shapeMeta(uid: string, x: number, y: number): Meta {
  const p = (v: string) => ({ valueType: "static", value: v });
  return {
    controlType: "shape",
    uid,
    properties: {
      shapeType: p("rectangle"),
      text: p("Hello"),
      x: p(String(x)),
      y: p(String(y)),
      width: p("120"),
      height: p("60"),
      embedded: p("false"),
      pinToGrid: p("false"),
    },
  };
}

async function fakeInvoke(command: string, args?: unknown): Promise<unknown> {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (command) {
    case "get_active_sheet":
      return 0;
    case "get_all_styles":
      fake.styleReads += 1;
      return [];
    case "list_scripts":
      return [];
    case "get_all_controls": {
      const out = [];
      for (const [k, metadata] of fake.controls) {
        const [s, r, c] = k.split(":").map(Number);
        if (s === a.sheetIndex) out.push({ sheetIndex: s, row: r, col: c, metadata: JSON.parse(JSON.stringify(metadata)) });
      }
      return out;
    }
    case "get_control_metadata": {
      const m = fake.controls.get(fake.key(a.sheetIndex as number, a.row as number, a.col as number));
      return m ? JSON.parse(JSON.stringify(m)) : null;
    }
    case "set_control_metadata": {
      // controls::assign_uid: a replace keeps the existing uid; a new key keeps
      // an incoming uid only when it is unique, else mints.
      const key = fake.key(a.sheetIndex as number, a.row as number, a.col as number);
      const incoming = JSON.parse(JSON.stringify(a.metadata)) as Meta;
      const existing = fake.controls.get(key);
      let uid: string;
      if (existing?.uid) {
        uid = existing.uid;
      } else if (incoming.uid && ![...fake.controls.values()].some((m) => m.uid === incoming.uid)) {
        uid = incoming.uid;
      } else {
        uid = `minted-${fake.nextUid++}`;
      }
      const stored = { ...incoming, uid };
      fake.controls.set(key, stored);
      return JSON.parse(JSON.stringify(stored));
    }
    case "set_control_property": {
      fake.setProperty.push({ ...a });
      const key = fake.key(a.sheetIndex as number, a.row as number, a.col as number);
      const m = fake.controls.get(key);
      if (!m) throw "no control exists here";
      if (a.controlType && a.controlType !== m.controlType) {
        throw `this is a '${m.controlType}'; a property write cannot change it to a '${String(a.controlType)}'.`;
      }
      if (a.valueType !== "static") throw "A property formula is a binding now";
      m.properties[a.propertyName as string] = { valueType: "static", value: a.value as string };
      return JSON.parse(JSON.stringify(m));
    }
    case "resolve_control_properties": {
      const key = fake.key(a.sheetIndex as number, a.row as number, a.col as number);
      fake.reads.set(key, (fake.reads.get(key) ?? 0) + 1);
      const m = fake.controls.get(key);
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(m?.properties ?? {})) out[k] = v.value;
      return out;
    }
    case "begin_undo_transaction":
      return 1;
    case "object_bindings": {
      const req = (a.request ?? {}) as Record<string, unknown>;
      fake.bindingRequests.push(JSON.parse(JSON.stringify(req)));
      switch (req.op) {
        case "set": {
          const binding = {
            object: req.object,
            path: req.path,
            formula: req.formula,
            displayFormula: req.formula,
            model: req.model ?? null,
            resolved: { object: req.object, path: req.path, value: "x", display: "x", error: null, pending: false },
          };
          return { kind: "binding", binding };
        }
        case "measures":
          return { kind: "measures", models: [] };
        case "analyze":
          return {
            kind: "analysis",
            analysis: {
              normalized: req.formula,
              displayNormalized: req.formula,
              sheets: [0],
              usesNames: false,
              usesTableRefs: false,
              usesIndirect: false,
              usesCube: false,
              measureRefs: [],
              model: null,
              error: null,
              warning: null,
            },
          };
        default:
          return { kind: "ack" };
      }
    }
    default:
      return null;
  }
}

vi.mock("@api/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/backend")>()),
  listenForEvent: vi.fn(async () => () => {}),
  listenTauriEvent: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn((cmd: string, args?: unknown) => fakeInvoke(cmd, args)),
}));
vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => {}),
}));

const CONTROLS: Loader = () => import("..");

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
if (!("ResizeObserver" in globalThis)) {
  Reflect.set(
    globalThis,
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
}

const A = { sheetIndex: 0, row: 2, col: 1 };
const B = { sheetIndex: 0, row: 5, col: 1 };
const ID_A = `control-0-2-1`;
const ID_B = `control-0-5-1`;

// ---------------------------------------------------------------------------
// The live modules (loaded after the harness's module reset).
// ---------------------------------------------------------------------------

let ext: Awaited<ReturnType<typeof loadHarness>>["ext"];
let api: typeof import("@api");
let events: typeof import("@api/events");
let overlays: typeof import("@api/gridOverlays");
let bindings: typeof import("@api/objectBindings");
let cache: typeof import("@api/objectBindings/cache");
let shapes: typeof import("../Shape/shapeRenderer");
let store: typeof import("../lib/floatingStore");
let clipboard: typeof import("../lib/controlClipboard");
const handlers = new Map<string, Array<(detail?: unknown) => void>>();
let gridRefreshes = 0;

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

function regionOf(id: string) {
  const r = overlays.getGridRegions().find((g) => g.id === id);
  if (!r) throw new Error(`${id} has no published region`);
  return r;
}

/** One paint of every control in the store, as the overlay pass does it. */
async function paintAll(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    for (const ctrl of store.getAllFloatingControls()) {
      shapes.renderFloatingShape({
        ctx: fakeCtx(),
        canvasWidth: 2000,
        canvasHeight: 2000,
        config: { rowHeaderWidth: 50, colHeaderHeight: 24 },
        viewport: { scrollX: 0, scrollY: 0 },
        region: regionOf(ctrl.id),
      } as never);
    }
    await settle();
  }
}

function readsOf(anchor: { sheetIndex: number; row: number; col: number }): number {
  return fake.reads.get(fake.key(anchor.sheetIndex, anchor.row, anchor.col)) ?? 0;
}

function handler(eventName: string): ((detail?: unknown) => void) | undefined {
  return handlers.get(eventName)?.[0];
}

beforeAll(async () => {
  fake.reset();
  fake.controls.set(fake.key(A.sheetIndex, A.row, A.col), shapeMeta("uid-A", 64, 64));
  fake.controls.set(fake.key(B.sheetIndex, B.row, B.col), shapeMeta("uid-B", 64, 200));
  const harness = await loadHarness(CONTROLS, { invokeBackend: fakeInvoke });
  ext = harness.ext;
  const recorder = {
    on: (eventName: string, cb: (detail?: unknown) => void) => {
      const list = handlers.get(eventName) ?? [];
      list.push(cb);
      handlers.set(eventName, list);
      return () => {
        handlers.set(eventName, (handlers.get(eventName) ?? []).filter((x) => x !== cb));
      };
    },
    emit: () => {},
  };
  const context = new Proxy(harness.context as unknown as Record<string, unknown>, {
    get: (t, p) => (p === "events" ? recorder : t[p as string]),
  }) as never;
  await ext.activate(context);
  await settle();
  api = await import("@api");
  events = await import("@api/events");
  overlays = await import("@api/gridOverlays");
  bindings = await import("@api/objectBindings");
  cache = await import("@api/objectBindings/cache");
  shapes = await import("../Shape/shapeRenderer");
  store = await import("../lib/floatingStore");
  clipboard = await import("../lib/controlClipboard");
  events.onAppEvent(api.AppEvents.GRID_REFRESH, () => {
    gridRefreshes += 1;
  });
  expect(store.getFloatingControl(ID_A), "the activation loaded control A").not.toBeNull();
  expect(store.getFloatingControl(ID_B), "the activation loaded control B").not.toBeNull();
}, 60_000);

afterAll(async () => {
  await ext.deactivate?.();
  await settle();
});

beforeEach(async () => {
  // Warm every paint cache, then count from zero.
  await paintAll();
  fake.reads.clear();
  fake.styleReads = 0;
  fake.setProperty = [];
  fake.bindingRequests = [];
  gridRefreshes = 0;
});

describe("CELLS_UPDATED and NAMED_RANGES_CHANGED", () => {
  it("CELLS_UPDATED still refreshes the style cache -- and invalidates no control and emits no GRID_REFRESH", async () => {
    const onCells = handler(api.AppEvents.CELLS_UPDATED);
    expect(onCells, "Controls listens to CELLS_UPDATED").toBeDefined();
    onCells!();
    await settle();
    expect(fake.styleReads, "refreshStyleCache() read the styles (in-cell buttons paint from them)").toBe(1);
    expect(gridRefreshes, "no GRID_REFRESH from a cell change").toBe(0);
    await paintAll();
    expect(readsOf(A) + readsOf(B), "no control was invalidated by a cell change").toBe(0);
  });

  it("there is no formula-property NAMED_RANGES_CHANGED handler any more", () => {
    expect(handlers.get(api.AppEvents.NAMED_RANGES_CHANGED) ?? []).toHaveLength(0);
  });
});

describe("onBindingsChanged repaints exactly the named controls", () => {
  it("a change naming control A re-reads A only, with no GRID_REFRESH", async () => {
    cache.notifyBindingsChanged({ objects: [{ kind: "control", id: "uid-A" }], reload: false });
    await settle();
    await paintAll();
    expect(readsOf(A), "A's paint cache was dropped and re-read").toBeGreaterThanOrEqual(1);
    expect(readsOf(B), "B was not touched").toBe(0);
    expect(gridRefreshes, "never GRID_REFRESH from a binding change (bridge loop)").toBe(0);
  });

  it("a change naming another kind (or an unknown uid) re-reads nothing", async () => {
    cache.notifyBindingsChanged({ objects: [{ kind: "chart", id: "uid-A" }], reload: false });
    cache.notifyBindingsChanged({ objects: [{ kind: "control", id: "nobody" }], reload: false });
    await settle();
    await paintAll();
    expect(readsOf(A) + readsOf(B)).toBe(0);
  });

  it("a reload re-reads every control", async () => {
    cache.notifyBindingsChanged({ objects: [], reload: true });
    await settle();
    await paintAll();
    expect(readsOf(A)).toBeGreaterThanOrEqual(1);
    expect(readsOf(B)).toBeGreaterThanOrEqual(1);
    expect(gridRefreshes).toBe(0);
  });
});

describe("the script door shape.setProperty", () => {
  it('writes "=A1" as STATIC text and keeps the control type ("" -- not "shape")', async () => {
    events.emitAppEvent("shape:setProperty", { instanceId: ID_A, key: "text", value: "=A1", oldValue: "Hello" });
    await settle();
    expect(fake.setProperty).toHaveLength(1);
    expect(fake.setProperty[0]).toMatchObject({
      sheetIndex: 0,
      row: 2,
      col: 1,
      controlType: "",
      propertyName: "text",
      valueType: "static",
      value: "=A1",
    });
    expect(fake.controls.get(fake.key(0, 2, 1))?.properties.text).toEqual({ valueType: "static", value: "=A1" });
  });

  it("works against a control that is NOT a shape (a button keeps being a button)", async () => {
    const key = fake.key(0, 5, 1);
    const before = fake.controls.get(key)!;
    fake.controls.set(key, { ...before, controlType: "button" });
    try {
      events.emitAppEvent("shape:setProperty", { instanceId: ID_B, key: "text", value: "Go", oldValue: "" });
      await settle();
      expect(fake.setProperty[0]).toMatchObject({ controlType: "", value: "Go" });
      expect(fake.controls.get(key)?.controlType).toBe("button");
      expect(fake.controls.get(key)?.properties.text.value).toBe("Go");
    } finally {
      fake.controls.set(key, { ...fake.controls.get(key)!, controlType: "shape" });
    }
  });
});

describe("the `control` binding registration", () => {
  it("a control region's ref is its BACKEND uid", async () => {
    expect(await bindings.bindingRefForRegion(regionOf(ID_A))).toEqual({ kind: "control", id: "uid-A" });
    expect(await bindings.bindingRefForRegion(regionOf(ID_B))).toEqual({ kind: "control", id: "uid-B" });
  });

  it("a shape or button script instance resolves to the same ref", async () => {
    expect(await bindings.bindingRefForInstance("shape", ID_A)).toEqual({ kind: "control", id: "uid-A" });
    expect(await bindings.bindingRefForInstance("button", ID_B)).toEqual({ kind: "control", id: "uid-B" });
    expect(await bindings.bindingRefForInstance("shape", "control-0-99-99"), "no control there").toBeNull();
  });

  it("offers only catalog-accepted rows of the shape's own definition list", async () => {
    const offered = await bindings.getBindableProperties(regionOf(ID_A));
    const pointers = offered?.properties.map((p) => p.pointer) ?? [];
    expect(pointers).toContain("/properties/text");
    expect(pointers).toContain("/properties/fill");
    expect(pointers).toContain("/properties/width");
    for (const never of ["/properties/name", "/properties/shapeType", "/properties/pinToGrid", "/properties/x"]) {
      expect(pointers, `${never} is never offered`).not.toContain(never);
    }
  });
});

describe("a_pasted_controls_ref_is_not_the_sources", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  it("a pasted copy of a bound shape has its own uid, and an fx edit on it writes Set with the COPY's uid", async () => {
    const snaps = await clipboard.snapshotControls([ID_A]);
    expect((snaps[0] as { metadata: Meta }).metadata.uid, "the LOCAL snapshot carries the source's uid").toBe("uid-A");
    const result = await clipboard.pasteControlSnapshots(snaps, {
      sheetIndex: 0,
      place: (r) => ({ x: r.x + 20, y: r.y + 20 }),
    });
    expect(result.refused).toEqual([]);
    expect(result.created).toHaveLength(1);
    const [row, col] = result.created[0].id.split(":").map(Number);
    const copyId = store.makeFloatingControlId(0, row, col);
    store.syncFloatingControlRegions();

    const sourceRef = await bindings.bindingRefForRegion(regionOf(ID_A));
    const copyRef = await bindings.bindingRefForRegion(regionOf(copyId));
    expect(sourceRef).toEqual({ kind: "control", id: "uid-A" });
    expect(copyRef, "the copy has a ref").not.toBeNull();
    expect(copyRef!.id, "the copy's ref is NOT the source's").not.toBe(sourceRef!.id);

    // The copy's Properties pane: fx on the Text row, type =A1, Enter.
    const { PropertiesPane } = await import("../PropertiesPane/PropertiesPane");
    await act(async () => {
      root.render(
        <PropertiesPane {...({ data: { sheetIndex: 0, row, col, controlType: "shape" } } as never)} />,
      );
    });
    await act(async () => {
      await settle();
    });
    const textRow = host.querySelector('[data-testid="control-prop-text"]');
    expect(textRow, "the Text row rendered").not.toBeNull();
    const fx = textRow!.querySelector<HTMLButtonElement>("[data-bindable-fx]");
    expect(fx, "the Text row offers fx").not.toBeNull();
    await act(async () => {
      fx!.click();
    });
    const input = textRow!.querySelector<HTMLInputElement>("[data-binding-formula-input]");
    expect(input, "fx on shows the formula editor").not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      input!.focus();
      setter?.call(input, "=A1");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await settle();
    });

    const sets = fake.bindingRequests.filter((r) => r.op === "set");
    expect(sets, "one Set was sent").toHaveLength(1);
    expect(sets[0]).toMatchObject({
      object: { kind: "control", id: copyRef!.id },
      path: "/properties/text",
      formula: "=A1",
    });
    expect(
      fake.setProperty.filter((w) => w.valueType !== "static"),
      "no formula-typed property write",
    ).toEqual([]);

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
});
