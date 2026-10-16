//! FILENAME: app/extensions/Controls/__tests__/controlObjectFormat.test.ts
// PURPOSE: The floating controls' format and pane providers (WP-C S13):
//          - the key mapping per control kind (D-FORMAT "control background =
//            fill, border = outline"; a navigator's container keys; a text
//            box's "none" / "0");
//          - ONE commit = ONE `set_control_appearance` invoke carrying every
//            changed key and ZERO `set_control_property` invokes (review R1-1:
//            those record no undo for a non-executable key), inside
//            commitObjectFormat's ONE transaction;
//          - a navigator's padding is never committed (WP-B's key, C3);
//          - `bindingPath` answers FROM the CONTAINER_BINDING_PATHS table, and
//            every pointer in it is a WP-D catalog row;
//          - the pane provider: Properties is the build tab, a run-mode button
//            or navigator never opens on a press, the header names the kind.
// CONTEXT: The backend is the Controls backend CHANNEL, bound to a recording
//          invoke -- the real `setControlAppearance` / `readControlLiteral`
//          run, so the invoke list IS what Rust would receive. The undo
//          transaction is the REAL runInUndoTransaction over doubled tauri-api
//          begin / commit (the objectFormat.test.ts pattern).

import { describe, it, expect, beforeEach, vi } from "vitest";

const log: string[] = [];
vi.mock("../../../src/core/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  beginUndoTransaction: vi.fn(async (label: string) => {
    log.push(`begin:${label}`);
  }),
  commitUndoTransaction: vi.fn(async () => {
    log.push("commit");
  }),
}));

const toasts: string[] = [];
vi.mock("@api/notifications", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  showToast: (message: string) => {
    toasts.push(message);
  },
}));

import type { GridRegion } from "@api/gridOverlays";
import { commitObjectFormat, registerObjectFormatProvider, resetObjectFormatProviders } from "@api/objectFormat";
import { getBindableProperties, isBindablePath } from "@api/objectBindings";
import { registerControlBindableProperties } from "../lib/controlBindings";
import { VISUAL_CONTAINER_FIELD_IDS } from "@api/visualContainer";
import { controlsBackend } from "../lib/controlsBackend";
import { readControlLiteral, setControlAppearance } from "../lib/controlApi";
import {
  CONTAINER_BINDING_KIND,
  CONTAINER_BINDING_PATHS,
  CONTROL_FORMAT_NO_GRADIENT,
  createControlObjectFormatProvider,
} from "../lib/controlObjectFormat";
import {
  CONTROL_CONTAINER_KINDS,
  controlContainerCapabilities,
  controlContainerWrites,
  controlFieldOffered,
  readControlContainer,
} from "../lib/controlContainerDefaults";
import { BACKGROUND_TRANSPARENCY_KEY } from "../Shape/shapeRecipe";
import {
  getControlContainer,
  getControlContainerEntry,
  noteControlProperties,
  resetControlContainers,
} from "../lib/controlContainer";
import { createControlObjectPaneProvider, CONTROL_PANE_TAB_PROPERTIES } from "../lib/controlObjectPane";

// ---------------------------------------------------------------------------
// The backend double: a control store, and every invoke recorded
// ---------------------------------------------------------------------------

const invokes: Array<{ cmd: string; args: Record<string, unknown> }> = [];
let store: Map<string, { controlType: string; properties: Record<string, { valueType: string; value: string }> }>;

function keyOf(s: number, r: number, c: number): string {
  return `${s}:${r}:${c}`;
}

function put(sheetIndex: number, row: number, col: number, controlType: string, props: Record<string, string>): void {
  const properties: Record<string, { valueType: string; value: string }> = {};
  for (const [k, v] of Object.entries(props)) properties[k] = { valueType: "static", value: v };
  store.set(keyOf(sheetIndex, row, col), { controlType, properties });
}

async function fakeInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  invokes.push({ cmd, args: args ?? {} });
  const a = (args ?? {}) as { sheetIndex: number; row: number; col: number };
  if (cmd === "get_control_metadata") {
    const m = store.get(keyOf(a.sheetIndex, a.row, a.col));
    return (m ? { uid: `uid-${a.row}-${a.col}`, ...m } : null) as T;
  }
  if (cmd === "set_control_appearance") {
    const changes = (args as { changes: Array<{ sheetIndex: number; row: number; col: number; properties: Array<{ key: string; value: string }> }> }).changes;
    for (const ch of changes) {
      const m = store.get(keyOf(ch.sheetIndex, ch.row, ch.col));
      if (!m) throw new Error("No control");
      for (const w of ch.properties) m.properties[w.key] = { valueType: "static", value: w.value };
    }
    return changes.length as T;
  }
  return null as T;
}

const REGION_TYPE = "floating-control";

function regionOf(controlType: string, row: number, col = 1): GridRegion {
  return {
    id: `control-0-${row}-${col}`,
    type: REGION_TYPE,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x: 10, y: 10, width: 200, height: 100 },
    data: { sheetIndex: 0, row, col, controlType },
  } as GridRegion;
}

const afterWrite = vi.fn();

function provider() {
  return createControlObjectFormatProvider({
    regionType: REGION_TYPE,
    readLiteral: readControlLiteral,
    setAppearance: setControlAppearance,
    afterWrite,
    bindingRefAt: async (s, r, c) => ({ kind: "control", id: `uid-${s}-${r}-${c}` }),
  });
}

/** The controls in play, written as the recipes write them. */
const SHAPE = { shapeType: "rectangle", fill: "#4472C4", stroke: "#2F528F", strokeWidth: "1", text: "" };
const TEXT_BOX = { shapeType: "textBox", fill: "none", stroke: "none", strokeWidth: "0", text: "" };
const BUTTON = { text: "Go", fill: "#e0e0e0", borderColor: "#999999" };
const IMAGE = { src: "" };
const NAVIGATOR = { orientation: "horizontal", padding: "6", fill: "#e0e0e0" };

beforeEach(() => {
  log.length = 0;
  toasts.length = 0;
  invokes.length = 0;
  afterWrite.mockClear();
  store = new Map();
  controlsBackend.set(fakeInvoke as never);
  resetControlContainers();
  resetObjectFormatProviders();
  put(0, 1, 1, "shape", SHAPE);
  put(0, 2, 1, "shape", TEXT_BOX);
  put(0, 3, 1, "button", BUTTON);
  put(0, 4, 1, "image", IMAGE);
  put(0, 5, 1, "pageNavigator", NAVIGATOR);
});

const appearanceCalls = () => invokes.filter((i) => i.cmd === "set_control_appearance");
const propertyCalls = () => invokes.filter((i) => i.cmd === "set_control_property");
function writesOf(call: { args: Record<string, unknown> }): Record<string, string> {
  const changes = (call.args as { changes: Array<{ properties: Array<{ key: string; value: string }> }> }).changes;
  expect(changes).toHaveLength(1);
  return Object.fromEntries(changes[0].properties.map((w) => [w.key, w.value]));
}

// ============================================================================
// Commit: one invoke, the right keys
// ============================================================================

describe("commit: ONE set_control_appearance, ZERO set_control_property", () => {
  it("a 3-key patch on a shape is ONE invoke carrying fill, strokeWidth and a container key", async () => {
    const p = provider();
    await p.commit(regionOf("shape", 1), {
      background: { color: "#ff0000" },
      border: { width: 3 },
      title: { show: true },
    });
    expect(appearanceCalls()).toHaveLength(1);
    expect(propertyCalls()).toHaveLength(0);
    expect(writesOf(appearanceCalls()[0])).toEqual({
      containerTitleShow: "true",
      fill: "#ff0000",
      strokeWidth: "3",
    });
    expect(afterWrite).toHaveBeenCalledTimes(1);
  });

  it("through commitObjectFormat: ONE transaction around the ONE invoke", async () => {
    registerObjectFormatProvider(provider());
    const out = await commitObjectFormat([
      { region: regionOf("shape", 1), patch: { shadow: { show: true, blur: 12 }, padding: { top: 8 } } },
    ]);
    expect(out).toEqual({ applied: 1, refused: [] });
    expect(log).toEqual(["begin:Format Object", "commit"]);
    expect(appearanceCalls()).toHaveLength(1);
    expect(propertyCalls()).toHaveLength(0);
    expect(writesOf(appearanceCalls()[0])).toEqual({
      containerPaddingTop: "8",
      containerShadowShow: "true",
      containerShadowBlur: "12",
    });
  });

  it("an unchanged patch writes nothing", async () => {
    await provider().commit(regionOf("shape", 1), { background: { color: "#4472C4" }, border: { show: true } });
    expect(appearanceCalls()).toHaveLength(0);
    expect(afterWrite).not.toHaveBeenCalled();
  });

  it("a cleared container field writes \"\" (the family default)", async () => {
    put(0, 1, 1, "shape", { ...SHAPE, containerTitleText: "Sales" });
    await provider().commit(regionOf("shape", 1), { title: { text: null } });
    expect(writesOf(appearanceCalls()[0])).toEqual({ containerTitleText: "" });
  });
});

describe("the key map per kind", () => {
  it("shape: hiding the background is fill \"none\", hiding the border strokeWidth \"0\"", async () => {
    await provider().commit(regionOf("shape", 1), { background: { show: false }, border: { show: false } });
    expect(writesOf(appearanceCalls()[0])).toEqual({ fill: "none", strokeWidth: "0" });
  });

  it("text box: turning the background and border ON gives them real values", async () => {
    await provider().commit(regionOf("shape", 2), { background: { show: true }, border: { show: true } });
    const w = writesOf(appearanceCalls()[0]);
    expect(w.fill).toBe("#ffffff");
    expect(w.strokeWidth).toBe("1");
    expect(w.stroke).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it("text box: a border width alone turns its border on", async () => {
    await provider().commit(regionOf("shape", 2), { border: { width: 2 } });
    expect(writesOf(appearanceCalls()[0])).toMatchObject({ strokeWidth: "2" });
  });

  it("button: border colour is borderColor, the corner radius containerBorderRadius", async () => {
    await provider().commit(regionOf("button", 3), { border: { color: "#112233", radius: 8 } });
    expect(writesOf(appearanceCalls()[0])).toEqual({ borderColor: "#112233", containerBorderRadius: "8" });
  });

  it("button: a title is refused with a sentence and nothing is written", async () => {
    await expect(provider().commit(regionOf("button", 3), { title: { show: true } })).rejects.toThrow(
      "A button has no 'title.show' format setting.",
    );
    expect(appearanceCalls()).toHaveLength(0);
  });

  it("picture: background and border are fill / stroke / strokeWidth, its transparency a container key", async () => {
    await provider().commit(regionOf("image", 4), {
      background: { show: true, color: "#abcdef", transparency: 40 },
      border: { show: true, color: "#000000", width: 2 },
    });
    expect(writesOf(appearanceCalls()[0])).toEqual({
      containerBackgroundTransparency: "40",
      fill: "#abcdef",
      strokeWidth: "2",
      stroke: "#000000",
    });
  });

  it("navigator: its container is container* keys -- never fill / borderColor (they style its items)", async () => {
    await provider().commit(regionOf("pageNavigator", 5), {
      background: { show: true, color: "#fafafa" },
      border: { show: true, color: "#333333", width: 2 },
    });
    expect(writesOf(appearanceCalls()[0])).toEqual({
      containerBackgroundShow: "true",
      containerBackgroundColor: "#fafafa",
      containerBorderShow: "true",
      containerBorderColor: "#333333",
      containerBorderWidth: "2",
    });
  });

  it("navigator: padding is NOT committed (WP-B's padding key is its one editor)", async () => {
    await expect(provider().commit(regionOf("pageNavigator", 5), { padding: { top: 12 } })).rejects.toThrow(
      "A page navigator's padding is its own Padding property",
    );
    expect(appearanceCalls()).toHaveLength(0);
    expect(store.get(keyOf(0, 5, 1))!.properties.padding.value).toBe("6");
  });

  it("a gradient is refused (no flat key holds one)", async () => {
    await expect(
      provider().commit(regionOf("shape", 1), {
        background: { gradient: { type: "linear", stops: [{ offset: 0, color: "#000" }, { offset: 1, color: "#fff" }] } },
      }),
    ).rejects.toThrow(CONTROL_FORMAT_NO_GRADIENT);
  });
});

// ============================================================================
// Read, preview, resolve
// ============================================================================

describe("read / preview", () => {
  it("read() is the stored container of the last properties read; a navigator's padding is its padding key", () => {
    noteControlProperties("control-0-5-1", "pageNavigator", { ...NAVIGATOR, containerTitleShow: "true" });
    const p = provider();
    const stored = p.read(regionOf("pageNavigator", 5));
    expect(stored.padding).toEqual({ top: 6, right: 6, bottom: 6, left: 6 });
    expect(stored.title).toEqual({ show: true });
    expect(getControlContainer("control-0-5-1")?.paint.background).toBe("core");
  });

  it("a text box reads as no background and no border", () => {
    noteControlProperties("control-0-2-1", "shape", TEXT_BOX);
    expect(getControlContainerEntry("control-0-2-1")?.kind).toBe("textBox");
    const c = getControlContainer("control-0-2-1")!;
    expect(c.background.show).toBe(false);
    expect(c.border.show).toBe(false);
  });

  it("preview lays the would-be keys over the read in memory, and endPreview takes them away", () => {
    noteControlProperties("control-0-1-1", "shape", SHAPE);
    const p = provider();
    p.preview!(regionOf("shape", 1), { padding: { left: 20 } });
    expect(getControlContainer("control-0-1-1")?.padding.left).toBe(20);
    p.endPreview!();
    expect(getControlContainer("control-0-1-1")?.padding.left).toBe(0);
    expect(invokes.filter((i) => i.cmd !== "get_control_metadata")).toHaveLength(0);
  });
});

// ============================================================================
// Bindings: from the table, every pointer a catalog row
// ============================================================================

describe("bindingPath answers FROM CONTAINER_BINDING_PATHS", () => {
  it("is the control kind", () => {
    expect(CONTAINER_BINDING_KIND).toBe("control");
  });

  it("per kind, per field: the table's answer; null wherever the capabilities hide the field", () => {
    const p = provider();
    const regions = {
      shape: regionOf("shape", 1),
      textBox: regionOf("shape", 2),
      button: regionOf("button", 3),
      image: regionOf("image", 4),
      pageNavigator: regionOf("pageNavigator", 5),
    } as const;
    noteControlProperties("control-0-2-1", "shape", TEXT_BOX);
    for (const kind of CONTROL_CONTAINER_KINDS) {
      const caps = controlContainerCapabilities(kind);
      for (const field of VISUAL_CONTAINER_FIELD_IDS) {
        const expected = CONTAINER_BINDING_PATHS[kind][field];
        expect(p.bindingPath!(regions[kind], field), `${kind} ${field}`).toBe(expected);
        if (!controlFieldOffered(caps, field)) expect(expected, `${kind} ${field} is hidden`).toBeNull();
        if (expected !== null) expect(isBindablePath("control", expected), `${kind} ${expected}`).not.toBeNull();
      }
    }
  });

  it("lockAspect and the derived show flags of painted kinds are never bindable", () => {
    for (const kind of ["shape", "textBox", "button", "image"] as const) {
      expect(CONTAINER_BINDING_PATHS[kind].lockAspect).toBeNull();
      expect(CONTAINER_BINDING_PATHS[kind]["background.show"]).toBeNull();
      expect(CONTAINER_BINDING_PATHS[kind]["border.show"]).toBeNull();
    }
    expect(CONTAINER_BINDING_PATHS.shape["background.color"]).toBe("/properties/fill");
    expect(CONTAINER_BINDING_PATHS.button["border.color"]).toBe("/properties/borderColor");
    expect(CONTAINER_BINDING_PATHS.pageNavigator["background.color"]).toBe("/properties/containerBackgroundColor");
  });
});

// ============================================================================
// The pane provider
// ============================================================================

describe("the control's object-pane provider", () => {
  const Component = () => null;
  let designMode = false;
  const pane = () =>
    createControlObjectPaneProvider({
      regionType: REGION_TYPE,
      PropertiesComponent: Component,
      isDesignMode: () => designMode,
    });

  it("offers ONE build tab, Properties, hosting the Properties pane with the control's anchor", () => {
    const tabs = pane().tabs(regionOf("shape", 1));
    expect(tabs.map((t) => t.id)).toEqual([CONTROL_PANE_TAB_PROPERTIES]);
    const el = tabs[0].render({
      region: regionOf("shape", 1),
      readOnly: false,
      readOnlyReason: null,
      activeTabId: "properties",
    }) as { type: unknown; key: string; props: { data: Record<string, unknown> } };
    expect(el.type).toBe(Component);
    expect(el.key).toBe("control-0-1-1");
    expect(el.props.data).toEqual({ row: 1, col: 1, sheetIndex: 0, controlType: "shape" });
  });

  it("a run-mode button or navigator never opens on a press; in Design Mode it does; a shape always does", () => {
    designMode = false;
    expect(pane().opensOnPress!(regionOf("button", 3))).toBe(false);
    expect(pane().opensOnPress!(regionOf("pageNavigator", 5))).toBe(false);
    expect(pane().opensOnPress!(regionOf("shape", 1))).toBe(true);
    expect(pane().opensOnPress!(regionOf("image", 4))).toBe(true);
    designMode = true;
    expect(pane().opensOnPress!(regionOf("button", 3))).toBe(true);
    designMode = false;
  });

  it("the header names the kind, a text box as a text box, and the control's name", () => {
    expect(pane().headerOf!(regionOf("button", 3))).toBe("Button");
    noteControlProperties("control-0-2-1", "shape", { ...TEXT_BOX, name: "Note" });
    expect(pane().headerOf!(regionOf("shape", 2))).toBe("Text box - Note");
  });
});

// ============================================================================
// WP-D's ONE control registration lists the container fields too
// ============================================================================

describe("the control kind's bindable properties append the container's", () => {
  it("a shape offers its own rows AND its container fields, each pointer once, all catalog rows", async () => {
    registerObjectFormatProvider(provider());
    const off = registerControlBindableProperties();
    try {
      const got = await getBindableProperties(regionOf("shape", 1));
      expect(got?.ref).toEqual({ kind: "control", id: "uid-1-1" });
      const pointers = got!.properties.map((d) => d.pointer);
      expect(new Set(pointers).size, "a pointer offered twice").toBe(pointers.length);
      // The shape's own fill row IS its background colour: offered once.
      expect(pointers.filter((p) => p === "/properties/fill")).toHaveLength(1);
      // Container fields the rows do not offer are appended under "Format".
      const title = got!.properties.find((d) => d.pointer === "/properties/containerTitleText");
      expect(title?.group).toBe("Format");
      expect(pointers).toContain("/properties/containerShadowBlur");
      // Never a field the shape's capabilities hide, never lockAspect.
      expect(pointers).not.toContain("/properties/containerBorderRadius");
      expect(pointers).not.toContain("/properties/containerLockAspect");
      for (const p of pointers) expect(isBindablePath("control", p), p).not.toBeNull();
    } finally {
      off();
    }
  });

  it("a button offers no title rows (it has none) but its corner radius", async () => {
    registerObjectFormatProvider(provider());
    const off = registerControlBindableProperties();
    try {
      const pointers = (await getBindableProperties(regionOf("button", 3)))!.properties.map((d) => d.pointer);
      expect(pointers).toContain("/properties/containerBorderRadius");
      expect(pointers.some((p) => p.startsWith("/properties/containerTitle"))).toBe(false);
    } finally {
      off();
    }
  });
});

// ============================================================================
// Background transparency on every kind (owner F5)
// ============================================================================

describe("Effects > Background > Transparency is offered for every control kind", () => {
  // SABOTAGE (confirmed): put `backgroundTransparency: false` back in the
  // shared base of controlContainerCapabilities -> shape, text box and button
  // lose the row.
  it("a shape, a text box and a button offer it, as a picture and a navigator do", () => {
    for (const kind of CONTROL_CONTAINER_KINDS) {
      const caps = controlContainerCapabilities(kind);
      expect(caps.backgroundTransparency, kind).toBe(true);
      expect(controlFieldOffered(caps, "background.transparency"), kind).toBe(true);
    }
  });

  it("the write is the one flat key the renderer reads", () => {
    for (const kind of ["shape", "textBox", "button"] as const) {
      const writes = controlContainerWrites(kind, { fill: "#4472C4" }, { background: { transparency: 40 } });
      expect(writes, kind).toEqual([{ key: BACKGROUND_TRANSPARENCY_KEY, value: "40" }]);
      const stored = readControlContainer(kind, { fill: "#4472C4", [BACKGROUND_TRANSPARENCY_KEY]: "40" });
      expect(stored.background?.transparency, kind).toBe(40);
    }
  });
});
