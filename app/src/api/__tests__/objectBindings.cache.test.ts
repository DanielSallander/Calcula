//! FILENAME: app/src/api/__tests__/objectBindings.cache.test.ts
// PURPOSE: The seam's cache follows the Rust store: an install (and a
//          `reload` announcement) re-lists and re-resolves; a value
//          announcement updates only what changed and tells listeners about
//          exactly those objects; set/clear update the cache from Rust's answer;
//          a refusal arrives as Rust's own sentence; a literal write announces
//          the domains Rust reports; and an answer about the PREVIOUS workbook
//          can never refill the cache after File > New.
// CONTEXT: The real seam over a doubled backend door (`invokeBackend`) and a
//          doubled Tauri event listener. Requests are recorded with the exact
//          wire shape Rust's `ObjectBindingsRequest` deserialises.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  ObjectBindingInfo,
  ObjectBindingRef,
  ObjectBindingsRequest,
  ResolvedBinding,
} from "../types";

const h = vi.hoisted(() => ({
  requests: [] as unknown[],
  bindings: [] as unknown[],
  values: [] as unknown[],
  refuse: null as string | null,
  literalDomains: [] as string[],
  /** Resolves a held `list` answer (to model a slow reload). */
  holdList: null as null | { release: () => void; promise: Promise<void> },
  tauri: new Map<string, (payload: unknown) => void>(),
}));

vi.mock("../backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../backend")>()),
  invokeBackend: async (cmd: string, args?: { request: ObjectBindingsRequest }) => {
    if (cmd !== "object_bindings") throw new Error(`unexpected command ${cmd}`);
    const req = args!.request;
    h.requests.push(JSON.parse(JSON.stringify(req)));
    if (h.refuse) throw h.refuse;
    switch (req.op) {
      case "list": {
        const snapshot = JSON.parse(JSON.stringify(h.bindings));
        if (h.holdList) await h.holdList.promise;
        return { kind: "bindings", bindings: snapshot };
      }
      case "resolveAll":
        return { kind: "resolved", values: JSON.parse(JSON.stringify(h.values)) };
      case "cellsChanged":
        return { kind: "resolved", values: [] };
      case "setPageFilters":
      case "refreshMeasures":
        return { kind: "ack" };
      case "set": {
        const resolved = { object: req.object, path: req.path, value: "v", display: "v", error: null, pending: false };
        const binding = {
          object: req.object,
          path: req.path,
          formula: req.formula.replace(/;/g, ","),
          displayFormula: req.formula,
          model: req.model,
          resolved,
        };
        h.bindings.push(binding);
        return { kind: "binding", binding };
      }
      case "clear":
        return { kind: "cleared", removed: true };
      case "setLiteral":
        return { kind: "literalSet", domains: h.literalDomains };
      default:
        throw new Error(`unexpected op ${req.op}`);
    }
  },
  listenTauriEvent: async (event: string, cb: (payload: unknown) => void) => {
    h.tauri.set(event, cb);
    return () => h.tauri.delete(event);
  },
}));

type Seam = typeof import("../objectBindings");
let seam: Seam;
let events: typeof import("../events");
let uninstall: () => void = () => {};

const CHART: ObjectBindingRef = { kind: "chart", id: "c1" };
const SLICER: ObjectBindingRef = { kind: "slicer", id: "s1" };

function info(object: ObjectBindingRef, p: string, formula: string): ObjectBindingInfo {
  return { object, path: p, formula, displayFormula: formula, model: null, resolved: null };
}
function val(object: ObjectBindingRef, p: string, display: string, extra: Partial<ResolvedBinding> = {}): ResolvedBinding {
  return { object, path: p, value: display, display, error: null, pending: false, ...extra };
}

/** Let every queued request and its continuation run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

function ops(): string[] {
  return (h.requests as ObjectBindingsRequest[]).map((r) => r.op);
}

beforeEach(async () => {
  vi.resetModules();
  h.requests = [];
  h.bindings = [info(CHART, "/spec/title", "=Data!A1"), info(SLICER, "/headerText", "=Data!B1")];
  h.values = [val(CHART, "/spec/title", "Revenue"), val(SLICER, "/headerText", "Region")];
  h.refuse = null;
  h.literalDomains = [];
  h.holdList = null;
  h.tauri.clear();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
  seam = await import("../objectBindings");
  events = await import("../events");
});

afterEach(() => {
  uninstall();
  vi.unstubAllGlobals();
});

async function install(): Promise<Array<{ objects: ObjectBindingRef[]; reload: boolean }>> {
  const heard: Array<{ objects: ObjectBindingRef[]; reload: boolean }> = [];
  seam.onBindingsChanged((c) => heard.push(c));
  uninstall = seam.installObjectBindingsBridge();
  await settle();
  return heard;
}

describe("the binding cache", () => {
  it("is filled on install: List then ResolveAll, and listeners hear one reload", async () => {
    const heard = await install();
    expect(ops()).toEqual(["setPageFilters", "list", "resolveAll"]);
    expect(h.requests[1]).toEqual({ op: "list", object: null });
    expect(seam.listBindings().map((b) => `${b.object.kind}:${b.path}`)).toEqual([
      "chart:/spec/title",
      "slicer:/headerText",
    ]);
    expect(seam.listBindings(CHART)).toHaveLength(1);
    expect(seam.getBinding(CHART, "/spec/title")?.formula).toBe("=Data!A1");
    expect(seam.getResolved(CHART, "/spec/title")?.display).toBe("Revenue");
    expect(seam.getBinding(CHART, "/spec/title")?.resolved?.display).toBe("Revenue");
    expect([...seam.getResolvedForObject(SLICER).keys()]).toEqual(["/headerText"]);
    expect(heard).toHaveLength(1);
    expect(heard[0].reload).toBe(true);
    expect(heard[0].objects).toEqual(expect.arrayContaining([CHART, SLICER]));
  });

  it("a value announcement notifies ONLY the objects whose values changed", async () => {
    const heard = await install();
    heard.length = 0;
    h.tauri.get(seam.BACKEND_OBJECT_BINDINGS_EVENT)!({
      values: [val(CHART, "/spec/title", "Revenue 2026"), val(SLICER, "/headerText", "Region")],
      reload: false,
    });
    expect(heard).toEqual([{ objects: [CHART], reload: false }]);
    expect(seam.getResolved(CHART, "/spec/title")?.display).toBe("Revenue 2026");
    // The same value again is not a change: no second repaint.
    h.tauri.get(seam.BACKEND_OBJECT_BINDINGS_EVENT)!({ values: [val(CHART, "/spec/title", "Revenue 2026")], reload: false });
    expect(heard).toHaveLength(1);
  });

  it("a reload announcement re-lists and reports exactly the objects that differ", async () => {
    const heard = await install();
    heard.length = 0;
    h.requests = [];
    h.bindings = [info(CHART, "/spec/title", "=Data!A2"), info(SLICER, "/headerText", "=Data!B1")];
    h.tauri.get(seam.BACKEND_OBJECT_BINDINGS_EVENT)!({ values: [], reload: true });
    await settle();
    expect(ops()).toEqual(["list", "resolveAll"]);
    expect(heard).toEqual([{ objects: [CHART], reload: true }]);
    expect(seam.getBinding(CHART, "/spec/title")?.formula).toBe("=Data!A2");
    // An unchanged reload says nothing at all.
    heard.length = 0;
    h.tauri.get(seam.BACKEND_OBJECT_BINDINGS_EVENT)!({ values: [], reload: true });
    await settle();
    expect(heard).toEqual([]);
  });

  it("setBinding sends the page filters first, then Set with the wire shape, and caches the answer", async () => {
    await install();
    h.requests = [];
    const heard: unknown[] = [];
    seam.onBindingsChanged((c) => heard.push(c));
    const got = await seam.setBinding({ kind: "control", id: "u1" }, "/properties/text", "=Data!A1;1");
    expect(ops()).toEqual(["setPageFilters", "set"]);
    expect(h.requests[1]).toEqual({
      op: "set",
      object: { kind: "control", id: "u1" },
      path: "/properties/text",
      formula: "=Data!A1;1",
      model: null,
      invariant: null,
      source: null,
    });
    expect(got.formula).toBe("=Data!A1,1");
    expect(seam.getBinding({ kind: "control", id: "u1" }, "/properties/text")?.displayFormula).toBe("=Data!A1;1");
    expect(seam.getResolved({ kind: "control", id: "u1" }, "/properties/text")?.display).toBe("v");
    expect(heard).toEqual([{ objects: [{ kind: "control", id: "u1" }], reload: false }]);
  });

  it("scripts and AI pass invariant + source through unchanged", async () => {
    await install();
    h.requests = [];
    await seam.setBinding(CHART, "/spec/xAxis/title", "=Data!C1", {
      invariant: true,
      model: "m1",
      source: { kind: "script", scriptId: "s-1", unlocked: false },
    });
    expect(h.requests[1]).toMatchObject({
      op: "set",
      invariant: true,
      model: "m1",
      source: { kind: "script", scriptId: "s-1", unlocked: false },
    });
  });

  it("clearBinding removes the binding and its value from the cache", async () => {
    await install();
    expect(await seam.clearBinding(CHART, "/spec/title")).toBe(true);
    expect(seam.getBinding(CHART, "/spec/title")).toBeNull();
    expect(seam.getResolved(CHART, "/spec/title")).toBeNull();
    expect(h.requests.at(-1)).toEqual({ op: "clear", object: CHART, path: "/spec/title", source: null });
  });

  it("a refusal rejects with a BindingRefusal carrying Rust's sentence, and leaves the cache alone", async () => {
    await install();
    h.refuse = "Bind is refused: the sheet is protected and does not allow editing objects.";
    const err = await seam.setBinding(CHART, "/spec/title", "=A1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(seam.BindingRefusal);
    expect((err as InstanceType<Seam["BindingRefusal"]>).sentence).toBe(h.refuse);
    expect(seam.getBinding(CHART, "/spec/title")?.formula).toBe("=Data!A1");
  });

  it("setLiteral announces the MutationDomains Rust reports (and nothing when unchanged)", async () => {
    await install();
    const seen: unknown[] = [];
    const off = events.onAppEvent(events.AppEvents.MUTATION_REFRESH, (d) => seen.push(d));
    h.literalDomains = ["objects"];
    await seam.setLiteral(CHART, "/spec/title", "Plain");
    expect(h.requests.at(-1)).toEqual({ op: "setLiteral", object: CHART, path: "/spec/title", value: "Plain", source: null });
    expect(seen).toEqual([{ domains: ["objects"], source: "commit" }]);
    h.literalDomains = [];
    await seam.setLiteral(CHART, "/spec/title", "Plain");
    expect(seen).toHaveLength(1);
    off();
  });

  it("an answer about the PREVIOUS workbook never refills the cache after File > New", async () => {
    await install();
    let release!: () => void;
    h.holdList = { release: () => release(), promise: new Promise<void>((r) => (release = r)) };
    h.tauri.get(seam.BACKEND_OBJECT_BINDINGS_EVENT)!({ values: [], reload: true });
    await settle(); // the reload's List is now in flight, holding the OLD set

    const heard: Array<{ objects: ObjectBindingRef[]; reload: boolean }> = [];
    seam.onBindingsChanged((c) => heard.push(c));
    h.bindings = [];
    h.values = [];
    events.emitAppEvent(events.AppEvents.AFTER_NEW);
    expect(seam.listBindings()).toEqual([]);
    expect(heard[0]).toEqual({ objects: expect.arrayContaining([CHART, SLICER]), reload: true });

    h.holdList = null; // the NEW workbook's List answers at once
    release(); // ...and the old one finally answers, with the OLD set
    await settle();
    expect(seam.listBindings(), "the stale answer must be dropped").toEqual([]);
    expect(seam.getResolved(CHART, "/spec/title")).toBeNull();
    // The end state alone would converge (the NEW workbook's reload empties the
    // cache again); what proves the stale answer was dropped is that nobody was
    // ever told the old objects came back.
    expect(heard, "only the reset itself was announced").toHaveLength(1);
  });
});

describe("the registry", () => {
  const region = (type: string, id = "r1") =>
    ({ id, type, startRow: 0, startCol: 0, endRow: 0, endCol: 0 }) as import("../gridOverlays").GridRegion;

  it("drops (and logs) a descriptor whose pointer the catalog does not know", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    seam.registerBindableProperties({
      kind: "chart",
      regionTypes: ["chart"],
      refOf: (r) => ({ kind: "chart", id: r.id }),
      properties: () => [
        { pointer: "/spec/title", label: "Title" },
        { pointer: "/spec/legend/position", label: "Legend" },
        { pointer: "/spec/series/*/name", label: "Wildcard is not a concrete path" },
      ],
    });
    const got = await seam.getBindableProperties(region("chart", "c9"));
    expect(got?.ref).toEqual({ kind: "chart", id: "c9" });
    expect(got?.properties.map((p) => p.pointer)).toEqual(["/spec/title"]);
    expect(errors).toHaveBeenCalledTimes(2);
    expect(String(errors.mock.calls[0][0])).toContain("/spec/legend/position");
    errors.mockRestore();
  });

  it("one registration per kind: a second REPLACES the first, loudly", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    seam.registerBindableProperties({ kind: "slicer", regionTypes: ["slicer"], refOf: () => ({ kind: "slicer", id: "a" }), properties: () => [] });
    seam.registerBindableProperties({ kind: "slicer", regionTypes: ["slicer"], refOf: () => ({ kind: "slicer", id: "b" }), properties: () => [] });
    expect(errors).toHaveBeenCalledTimes(1);
    expect(await seam.bindingRefForRegion(region("slicer"))).toEqual({ kind: "slicer", id: "b" });
    errors.mockRestore();
  });

  it("resolves async refs (a control's uid comes from the backend) and refuses malformed ones", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    seam.registerBindableProperties({
      kind: "control",
      regionTypes: ["floating-control"],
      instanceTypes: ["shape"],
      refOf: async (r) => (r.id === "bad" ? ({ kind: "chart", id: "x" } as ObjectBindingRef) : { kind: "control", id: "uid-1" }),
      refForInstance: async (id) => (id === "control-0-1-1" ? { kind: "control", id: "uid-1" } : null),
      properties: () => [{ pointer: "/properties/text", label: "Text" }],
    });
    expect(await seam.bindingRefForRegion(region("floating-control"))).toEqual({ kind: "control", id: "uid-1" });
    expect(await seam.bindingRefForRegion(region("floating-control", "bad"))).toBeNull();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(await seam.bindingRefForInstance("shape", "control-0-1-1")).toEqual({ kind: "control", id: "uid-1" });
    expect(await seam.bindingRefForInstance("chart", "control-0-1-1")).toBeNull();
    expect(await seam.bindingRefForRegion(region("pivot"))).toBeNull();
    errors.mockRestore();
  });
});
