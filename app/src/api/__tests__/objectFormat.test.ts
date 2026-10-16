//! FILENAME: app/src/api/__tests__/objectFormat.test.ts
// PURPOSE: The OBJECT FORMAT seam's contract (WP-C S4):
//          - the registry: last registration wins per type, a stale cleanup
//            never removes a newer provider;
//          - `commitObjectFormat`: ONE undo transaction for changes of several
//            families, every involved provider FLUSHED inside it (a debounced
//            chart save that lands after the commit is a second undo step),
//            a subscribed page refused with the Size and Position sentence,
//            Lock Objects NOT a refusal, an invalid patch never reaching a
//            provider, every refusal in ONE toast;
//          - `resolveContainerForObject`: bound > stored > defaults over WP-D's
//            cache, with pending / error / failing-leaf values skipped;
//          - `onContainerBindingsChanged`: filtered by kind, "all" on reload;
//          - `containerBindableDescriptors`: exactly the non-null binding paths.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ObjectBindingInfo, ObjectBindingRef, ResolvedBinding } from "../types";

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

const log: string[] = [];
vi.mock("../../core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/lib/tauri-api")>()),
  beginUndoTransaction: vi.fn(async (label: string) => {
    log.push(`begin:${label}`);
  }),
  commitUndoTransaction: vi.fn(async () => {
    log.push("commit");
  }),
}));

const toasts: Array<{ message: string; type?: string }> = [];
vi.mock("../notifications", () => ({
  showToast: (message: string, options: { type?: string } = {}) => {
    toasts.push({ message, type: options.type });
  },
}));

let surface: Record<string, unknown> | null = null;
vi.mock("../layoutSurface", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../layoutSurface")>()),
  getLayoutSurface: vi.fn(() => surface),
}));

/** WP-D's cache, doubled: path -> resolved / binding, for ONE object. */
const resolvedCache = new Map<string, ResolvedBinding>();
const bindingCache = new Map<string, ObjectBindingInfo>();
let bindingsListener: ((change: { objects: ObjectBindingRef[]; reload: boolean }) => void) | null = null;
const unsubscribeBindings = vi.fn();
vi.mock("../objectBindings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../objectBindings")>()),
  getResolved: vi.fn((_ref: ObjectBindingRef, path: string) => resolvedCache.get(path) ?? null),
  getBinding: vi.fn((_ref: ObjectBindingRef, path: string) => bindingCache.get(path) ?? null),
  onBindingsChanged: vi.fn((cb: typeof bindingsListener) => {
    bindingsListener = cb;
    return unsubscribeBindings;
  }),
  bindingRefForRegion: vi.fn(async () => ({ kind: "slicer", id: "from-registry" })),
}));

// The catalog rows for the container land in S7b; until then the double
// answers with the field's container type (text slots are "text").
vi.mock("../objectBindings/catalog", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../objectBindings/catalog")>();
  const { VISUAL_CONTAINER_FIELD_TYPES, containerFieldIdOfPointer } = await import("../visualContainer");
  return {
    ...orig,
    isBindablePath: vi.fn((kind: string, path: string) => {
      const id = containerFieldIdOfPointer(path.replace(/^\/container/, ""));
      if (!id) return null;
      return {
        kind,
        pointer: path,
        valueType: VISUAL_CONTAINER_FIELD_TYPES[id],
        origin: "container",
        protectEditObjects: false,
        lockObjectsPosition: false,
      };
    }),
  };
});

import {
  OBJECT_FORMAT_BINDING_GROUP,
  OBJECT_FORMAT_NO_PROVIDER,
  OBJECT_FORMAT_UNDO_LABEL,
  appendContainerBindableDescriptors,
  commitObjectFormat,
  containerBindableDescriptors,
  containerFieldLabel,
  endObjectFormatPreview,
  getObjectFormatProvider,
  hasObjectFormatProvider,
  objectFormatBindingRef,
  onContainerBindingsChanged,
  previewObjectFormat,
  readObjectFormat,
  registerObjectFormatProvider,
  resetObjectFormatProviders,
  resolveContainerForObject,
  type ContainerCapabilities,
  type ObjectFormatProvider,
} from "../objectFormat";
import { resetObjectGeometryProviders } from "../objectGeometry";
import { SIZE_POSITION_SUBSCRIBED } from "../objectPosition";
import {
  BASE_CONTAINER_DEFAULTS,
  containerFieldPointer,
  resolveVisualContainer,
  validateVisualContainerPatch,
  type ContainerFieldId,
  type VisualContainerFormat,
  type VisualContainerPatch,
} from "../visualContainer";
import type { GridRegion } from "../gridOverlays";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function region(id: string, type: string): GridRegion {
  return { id, type, startRow: 0, startCol: 0, endRow: 0, endCol: 0, floating: { x: 0, y: 0, width: 200, height: 100 }, data: {} };
}

const ALL_CAPS: ContainerCapabilities = {
  padding: true, lockAspect: true, title: true, titleText: "free", subtitle: true, divider: true,
  background: true, backgroundTransparency: true, gradient: true, border: true, borderRadius: true,
  shadow: true, dataFormat: false,
};

/** A macrotask: what an IPC round trip or a debounce actually costs. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

interface TestProvider extends ObjectFormatProvider {
  committed: Array<{ id: string; patch: VisualContainerPatch }>;
}

function provider(name: string, types: string[], extra: Partial<ObjectFormatProvider> = {}): TestProvider {
  const committed: TestProvider["committed"] = [];
  return {
    types,
    committed,
    read: () => ({}),
    defaults: () => BASE_CONTAINER_DEFAULTS,
    capabilities: () => ALL_CAPS,
    commit: async (r, patch) => {
      await tick();
      log.push(`${name}:commit:${r.id}`);
      committed.push({ id: r.id, patch });
    },
    ...extra,
  };
}

function resolved(path: string, value: unknown, extra: Partial<ResolvedBinding> = {}): ResolvedBinding {
  return {
    object: { kind: "slicer", id: "s1" },
    path,
    value,
    display: String(value),
    error: null,
    pending: false,
    ...extra,
  };
}

const SLICER: ObjectBindingRef = { kind: "slicer", id: "s1" };
const containerPath = (f: ContainerFieldId) => `/container${containerFieldPointer(f)}`;

beforeEach(() => {
  log.length = 0;
  toasts.length = 0;
  surface = null;
  resolvedCache.clear();
  bindingCache.clear();
  bindingsListener = null;
  unsubscribeBindings.mockClear();
  resetObjectFormatProviders();
  resetObjectGeometryProviders();
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe("objectFormat registry", () => {
  it("the last registration wins per type, and a stale cleanup removes nothing newer", () => {
    const a = provider("a", ["chart", "pivot"]);
    const b = provider("b", ["chart"]);
    const offA = registerObjectFormatProvider(a);
    registerObjectFormatProvider(b);
    expect(getObjectFormatProvider(region("c", "chart"))).toBe(b);
    expect(getObjectFormatProvider(region("p", "pivot"))).toBe(a);

    offA(); // stale for "chart" (b owns it now), current for "pivot"
    expect(getObjectFormatProvider(region("c", "chart"))).toBe(b);
    expect(hasObjectFormatProvider("pivot")).toBe(false);
    expect(getObjectFormatProvider(region("x", "nobody"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// commitObjectFormat
// ---------------------------------------------------------------------------

describe("commitObjectFormat", () => {
  it("opens ONE transaction for two regions of two families, every commit inside it", async () => {
    const charts = provider("chart", ["chart"]);
    const slicers = provider("slicer", ["slicer"]);
    registerObjectFormatProvider(charts);
    registerObjectFormatProvider(slicers);

    const out = await commitObjectFormat([
      { region: region("c1", "chart"), patch: { border: { show: true } } },
      { region: region("s1", "slicer"), patch: { title: { color: "#ff0000" } } },
    ]);

    expect(out).toEqual({ applied: 2, refused: [] });
    expect(log).toEqual([
      `begin:${OBJECT_FORMAT_UNDO_LABEL}`,
      "chart:commit:c1",
      "slicer:commit:s1",
      "commit",
    ]);
    expect(toasts).toEqual([]);
  });

  it("uses the caller's label when one is given", async () => {
    registerObjectFormatProvider(provider("chart", ["chart"]));
    await commitObjectFormat([{ region: region("c1", "chart"), patch: { lockAspect: true } }], "Lock aspect");
    expect(log[0]).toBe("begin:Lock aspect");
  });

  it("keeps the transaction open until every involved provider's flush has landed the deferred write", async () => {
    let scheduled: string | null = null;
    const debounced = provider("chart", ["chart"], {
      // The chart shape: commit SCHEDULES a save (updateChartSpec -> scheduleSave) ...
      commit: async (r) => {
        scheduled = r.id;
        log.push(`chart:scheduled:${r.id}`);
      },
      // ... and only flush performs it, a macrotask later (flushPendingChartSaves).
      flush: async () => {
        await tick();
        if (scheduled) log.push(`chart:write:${scheduled}`);
        scheduled = null;
      },
    });
    registerObjectFormatProvider(debounced);

    await commitObjectFormat([{ region: region("c1", "chart"), patch: { background: { color: "#123456" } } }]);

    // The write is INSIDE the transaction: before its commit, never after.
    expect(log).toEqual([
      `begin:${OBJECT_FORMAT_UNDO_LABEL}`,
      "chart:scheduled:c1",
      "chart:write:c1",
      "commit",
    ]);
  });

  it("does not flush a family that took no part", async () => {
    const flushed = vi.fn(async () => {});
    registerObjectFormatProvider(provider("chart", ["chart"]));
    registerObjectFormatProvider(provider("slicer", ["slicer"], { flush: flushed }));
    await commitObjectFormat([{ region: region("c1", "chart"), patch: { lockAspect: true } }]);
    expect(flushed).not.toHaveBeenCalled();
  });

  it("refuses every change on a SUBSCRIBED page with the sentence, and opens no transaction", async () => {
    surface = { editable: false, snap: null, page: { width: 1280, height: 720 } };
    const p = provider("chart", ["chart"]);
    registerObjectFormatProvider(p);

    const out = await commitObjectFormat([{ region: region("c1", "chart"), patch: { border: { show: true } } }]);

    expect(out).toEqual({ applied: 0, refused: [SIZE_POSITION_SUBSCRIBED] });
    expect(p.committed).toEqual([]);
    expect(log).toEqual([]);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].type).toBe("error");
    expect(toasts[0].message).toContain(SIZE_POSITION_SUBSCRIBED);
  });

  it("does NOT refuse under Lock Objects (the lock is about where objects are)", async () => {
    surface = {
      editable: true,
      snap: null,
      page: { width: 1280, height: 720 },
      pageLockedReason: "Objects on this page are locked.",
      isLocked: () => true,
    };
    const p = provider("chart", ["chart"]);
    registerObjectFormatProvider(p);

    const out = await commitObjectFormat([{ region: region("c1", "chart"), patch: { shadow: { show: true } } }]);

    expect(out).toEqual({ applied: 1, refused: [] });
    expect(p.committed).toHaveLength(1);
    expect(toasts).toEqual([]);
  });

  it("never hands an invalid patch to a provider; the refusal is the validator's sentence", async () => {
    const p = provider("chart", ["chart"]);
    registerObjectFormatProvider(p);
    const bad = { title: { fontSize: 999 } } as VisualContainerPatch;
    const sentence = validateVisualContainerPatch(bad);
    expect(sentence).not.toBeNull();

    const out = await commitObjectFormat([
      { region: region("c1", "chart"), patch: bad },
      { region: region("c2", "chart"), patch: { title: { fontSize: 20 } } },
    ]);

    expect(out.applied).toBe(1);
    expect(out.refused).toEqual([sentence]);
    expect(p.committed.map((c) => c.id)).toEqual(["c2"]);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toContain(sentence!);
  });

  it("collects every refusal of the call into ONE toast", async () => {
    registerObjectFormatProvider(
      provider("chart", ["chart"], {
        commit: async () => {
          throw new Error("The sheet is protected.");
        },
      }),
    );
    registerObjectFormatProvider(
      provider("slicer", ["slicer"], {
        commit: async () => {
          throw new Error("The slicer no longer exists.");
        },
      }),
    );

    const out = await commitObjectFormat([
      { region: region("c1", "chart"), patch: { border: { show: true } } },
      { region: region("s1", "slicer"), patch: { border: { show: true } } },
      { region: region("x1", "nobody"), patch: { border: { show: true } } },
    ]);

    expect(out.applied).toBe(0);
    // Pre-transaction refusals first, then the backend's, in commit order.
    expect(out.refused).toEqual([OBJECT_FORMAT_NO_PROVIDER, "The sheet is protected.", "The slicer no longer exists."]);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toContain("3 objects could not be formatted.");
    expect(toasts[0].message).toContain("The sheet is protected.");
    expect(toasts[0].message).toContain("The slicer no longer exists.");
    // The transaction still closed (what ran is one step).
    expect(log.filter((l) => l === "commit")).toHaveLength(1);
  });

  it("a failed flush turns that family's commits into refusals", async () => {
    registerObjectFormatProvider(
      provider("chart", ["chart"], {
        flush: async () => {
          throw new Error("The chart could not be saved.");
        },
      }),
    );
    const out = await commitObjectFormat([{ region: region("c1", "chart"), patch: { lockAspect: true } }]);
    expect(out).toEqual({ applied: 0, refused: ["The chart could not be saved."] });
    expect(toasts).toHaveLength(1);
  });

  it("ignores an empty patch: no transaction, no toast", async () => {
    const p = provider("chart", ["chart"]);
    registerObjectFormatProvider(p);
    const out = await commitObjectFormat([{ region: region("c1", "chart"), patch: {} }]);
    expect(out).toEqual({ applied: 0, refused: [] });
    expect(log).toEqual([]);
    expect(toasts).toEqual([]);
  });

  it("ends the preview in progress BEFORE the commit writes", async () => {
    const p = provider("chart", ["chart"], {
      preview: () => log.push("chart:preview"),
      endPreview: () => log.push("chart:endPreview"),
    });
    registerObjectFormatProvider(p);
    previewObjectFormat(region("c1", "chart"), { border: { color: "#00ff00" } });

    await commitObjectFormat([{ region: region("c1", "chart"), patch: { border: { color: "#00ff00" } } }]);

    expect(log).toEqual([
      "chart:preview",
      "chart:endPreview",
      `begin:${OBJECT_FORMAT_UNDO_LABEL}`,
      "chart:commit:c1",
      "commit",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

describe("previewObjectFormat / endObjectFormatPreview", () => {
  it("previews valid patches only, and restores each previewing family once", () => {
    const preview = vi.fn();
    const endPreview = vi.fn();
    registerObjectFormatProvider(provider("chart", ["chart"], { preview, endPreview }));

    previewObjectFormat(region("c1", "chart"), { title: { fontSize: 999 } } as VisualContainerPatch);
    expect(preview).not.toHaveBeenCalled();

    previewObjectFormat(region("c1", "chart"), { title: { fontSize: 18 } });
    previewObjectFormat(region("c1", "chart"), { title: { fontSize: 19 } });
    expect(preview).toHaveBeenCalledTimes(2);

    endObjectFormatPreview();
    endObjectFormatPreview();
    expect(endPreview).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// resolveContainerForObject
// ---------------------------------------------------------------------------

describe("resolveContainerForObject", () => {
  const stored: VisualContainerFormat = {
    title: { color: "#00ff00", text: "Stored title", fontSize: 12 },
    background: { color: "#eeeeee" },
    border: { color: "#111111" },
    shadow: { color: "#222222" },
  };

  it("bound > stored > defaults; pending, non-text errors and failing leaves are skipped", () => {
    resolvedCache.set(containerPath("title.color"), resolved(containerPath("title.color"), "#ff0000"));
    resolvedCache.set(containerPath("background.color"), resolved(containerPath("background.color"), null, { pending: true }));
    resolvedCache.set(
      containerPath("border.color"),
      resolved(containerPath("border.color"), null, { error: "The formula returned #REF!.", display: "#REF!" }),
    );
    // Passes WP-D coercion but not the container leaf check: ignored, the stored literal shows.
    resolvedCache.set(containerPath("shadow.color"), resolved(containerPath("shadow.color"), "rgb(1,2,3)"));
    // A TEXT slot shows its display, errors included.
    resolvedCache.set(
      containerPath("title.text"),
      resolved(containerPath("title.text"), null, { error: "The name does not exist.", display: "#NAME?" }),
    );
    resolvedCache.set(containerPath("border.width"), resolved(containerPath("border.width"), 3));

    const out = resolveContainerForObject(SLICER, stored, BASE_CONTAINER_DEFAULTS, containerPath);

    expect(out.title.color).toBe("#ff0000"); // bound beats the stored literal
    expect(out.background.color).toBe("#eeeeee"); // pending -> stored
    expect(out.border.color).toBe("#111111"); // error on a colour -> stored
    expect(out.shadow.color).toBe("#222222"); // failing leaf -> stored
    expect(out.title.text).toBe("#NAME?"); // text slot shows the display
    expect(out.border.width).toBe(3); // bound, nothing stored
    expect(out.title.fontSize).toBe(12); // stored, nothing bound
    expect(out.subtitle.color).toBe(BASE_CONTAINER_DEFAULTS.subtitle.color); // neither -> default
  });

  it("a field with no binding path is never overlaid", () => {
    resolvedCache.set(containerPath("title.color"), resolved(containerPath("title.color"), "#ff0000"));
    const out = resolveContainerForObject(SLICER, stored, BASE_CONTAINER_DEFAULTS, (f) =>
      f === "title.color" ? null : containerPath(f),
    );
    expect(out.title.color).toBe("#00ff00");
  });

  it("ref null (no ref yet, or a control Rust already overlays) is exactly resolveVisualContainer", () => {
    resolvedCache.set(containerPath("title.color"), resolved(containerPath("title.color"), "#ff0000"));
    expect(resolveContainerForObject(null, stored, BASE_CONTAINER_DEFAULTS, containerPath)).toEqual(
      resolveVisualContainer(stored, BASE_CONTAINER_DEFAULTS),
    );
  });
});

// ---------------------------------------------------------------------------
// onContainerBindingsChanged
// ---------------------------------------------------------------------------

describe("onContainerBindingsChanged", () => {
  it("passes only the kind's ids (de-duplicated), 'all' on reload, and nothing for other kinds", () => {
    const resync = vi.fn();
    const off = onContainerBindingsChanged("slicer", resync);
    expect(bindingsListener).not.toBeNull();

    bindingsListener!({
      objects: [
        { kind: "slicer", id: "s1" },
        { kind: "chart", id: "c1" },
        { kind: "slicer", id: "s2" },
        { kind: "slicer", id: "s1" },
      ],
      reload: false,
    });
    expect(resync).toHaveBeenLastCalledWith(["s1", "s2"]);

    resync.mockClear();
    bindingsListener!({ objects: [{ kind: "chart", id: "c1" }], reload: false });
    expect(resync).not.toHaveBeenCalled();

    bindingsListener!({ objects: [], reload: true });
    expect(resync).toHaveBeenLastCalledWith("all");

    off();
    expect(unsubscribeBindings).toHaveBeenCalledTimes(1);
  });

  it("a throwing resync does not escape into WP-D's dispatcher", () => {
    onContainerBindingsChanged("chart", () => {
      throw new Error("boom");
    });
    expect(() => bindingsListener!({ objects: [{ kind: "chart", id: "c1" }], reload: false })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Descriptors + read
// ---------------------------------------------------------------------------

describe("containerBindableDescriptors", () => {
  // In VISUAL_CONTAINER_FIELD_IDS order (the descriptors follow it).
  const offered: ContainerFieldId[] = ["title.fontSize", "title.color", "border.width", "shadow.show"];

  it("returns exactly the provider's non-null binding paths, labelled, in the Format group", () => {
    registerObjectFormatProvider(
      provider("slicer", ["slicer"], {
        bindingPath: (_r, f) => (offered.includes(f) ? containerPath(f) : null),
      }),
    );
    const out = containerBindableDescriptors(region("s1", "slicer"));
    expect(out.map((d) => d.pointer)).toEqual(offered.map(containerPath));
    expect(out.every((d) => d.group === OBJECT_FORMAT_BINDING_GROUP)).toBe(true);
    expect(out.map((d) => d.label)).toEqual(offered.map(containerFieldLabel));
    expect(containerFieldLabel("title.fontSize")).toBe("Title font size");
    expect(containerFieldLabel("lockAspect")).toBe("Lock aspect");
  });

  it("is empty without a provider or without bindingPath", () => {
    expect(containerBindableDescriptors(region("s1", "slicer"))).toEqual([]);
    registerObjectFormatProvider(provider("slicer", ["slicer"]));
    expect(containerBindableDescriptors(region("s1", "slicer"))).toEqual([]);
  });

  it("append never offers a pointer the family already lists", () => {
    registerObjectFormatProvider(
      provider("slicer", ["slicer"], {
        bindingPath: (_r, f) => (f === "title.text" ? "/headerText" : f === "title.color" ? containerPath(f) : null),
      }),
    );
    const base = [{ pointer: "/headerText", label: "Header" }];
    const out = appendContainerBindableDescriptors(base, region("s1", "slicer"));
    expect(out.map((d) => d.pointer)).toEqual(["/headerText", containerPath("title.color")]);
    expect(appendContainerBindableDescriptors(base, null)).toEqual(base);
  });
});

describe("readObjectFormat", () => {
  it("returns the literal, the capabilities and the bound fields of the ref", () => {
    const storedLiteral: VisualContainerFormat = { title: { color: "#00ff00" } };
    registerObjectFormatProvider(
      provider("slicer", ["slicer"], {
        read: () => storedLiteral,
        bindingPath: (_r, f) => containerPath(f),
      }),
    );
    const path = containerPath("title.color");
    bindingCache.set(path, {
      object: SLICER,
      path,
      formula: "IF(A1>0,\"#ff0000\",\"#0000ff\")",
      displayFormula: "IF(A1>0;\"#ff0000\";\"#0000ff\")",
      model: null,
      resolved: null,
    });
    resolvedCache.set(path, resolved(path, "#ff0000"));

    const snap = readObjectFormat(region("s1", "slicer"), SLICER)!;
    expect(snap.stored).toBe(storedLiteral);
    expect(snap.capabilities).toBe(ALL_CAPS);
    expect(snap.resolved.title.color).toBe("#ff0000");
    expect(Array.from(snap.bound.entries())).toEqual([
      ["title.color", { formula: "IF(A1>0;\"#ff0000\";\"#0000ff\")", display: "#ff0000", error: null }],
    ]);

    // Without a ref: nothing bound, no overlay of its own.
    const plain = readObjectFormat(region("s1", "slicer"))!;
    expect(plain.bound.size).toBe(0);
    expect(plain.resolved.title.color).toBe("#00ff00");
  });

  it("prefers the container the family PUBLISHED on the region", () => {
    registerObjectFormatProvider(provider("slicer", ["slicer"]));
    const published = resolveVisualContainer({ border: { show: true } }, BASE_CONTAINER_DEFAULTS);
    const r = { ...region("s1", "slicer"), container: published } as GridRegion;
    expect(readObjectFormat(r)!.resolved).toBe(published);
  });

  it("never reads a PREVIEW as the stored truth: while the family previews, its published container is ignored", () => {
    // Found live (object-pane-format J7, 2026-10-16): a slider dragged on an
    // untouched field republished the region with the previewed value, the
    // snapshot said the field "already showed" it, and the commit wrote nothing.
    registerObjectFormatProvider(provider("chart", ["chart"], { preview: vi.fn(), endPreview: vi.fn() }));
    const previewed = resolveVisualContainer({ background: { transparency: 50 } }, BASE_CONTAINER_DEFAULTS);
    const r = { ...region("c1", "chart"), container: previewed } as GridRegion;

    previewObjectFormat(r, { background: { transparency: 50 } });
    expect(previewed.background.alpha).toBeCloseTo(0.5);
    expect(readObjectFormat(r)!.resolved.background.alpha).toBe(BASE_CONTAINER_DEFAULTS.background.alpha);

    endObjectFormatPreview();
    expect(readObjectFormat(r)!.resolved).toBe(previewed);
  });

  it("is null without a provider", () => {
    expect(readObjectFormat(region("s1", "slicer"))).toBeNull();
  });
});

describe("objectFormatBindingRef", () => {
  it("asks the provider first (async, ruling R5), else the family's WP-D registration", async () => {
    registerObjectFormatProvider(provider("control", ["control"], { bindingRef: async () => ({ kind: "control", id: "uid-7" }) }));
    registerObjectFormatProvider(provider("slicer", ["slicer"]));
    expect(await objectFormatBindingRef(region("k", "control"))).toEqual({ kind: "control", id: "uid-7" });
    expect(await objectFormatBindingRef(region("s", "slicer"))).toEqual({ kind: "slicer", id: "from-registry" });
  });
});
