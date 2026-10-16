//! FILENAME: app/extensions/BuiltIn/ObjectPane/__tests__/formatCards.test.tsx
// PURPOSE: The Format tab's General cards, rendered against a doubled family
//          format provider:
//            - each card commits the right PATCH through commitObjectFormat
//              (one call per committed field; an unchanged blur commits nothing;
//              a number is clamped into its field's range);
//            - the geometry rows are DISABLED with the Lock Objects sentence
//              while Effects stay enabled (format is not geometry);
//            - Lock aspect ratio on: a Width commit also commits the Height by
//              the ratio (ONE geometry change, "Size and Position");
//            - an identity title is read-only with "rename it", and Rename
//              commits `title.text` (the family renames);
//            - the Data format row's "Use source format" sets null;
//            - a BINDABLE row renders WP-D's BindableField with the provider's
//              ref + path (the widget doubled); a non-bindable one does not;
//            - capabilities hide what a family does not offer;
//            - a transparency slider PREVIEWS while it drags.
// CONTEXT: @testing-library/react is not installed; react-dom + `act`.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  commit: vi.fn(async (_changes: unknown, _label?: string) => ({ applied: 1, refused: [] as string[] })),
  preview: vi.fn(),
  geometry: vi.fn(async (_changes: unknown, _label: string) => ({ committed: 1, refused: 0, skipped: 0 })),
  prompt: vi.fn(async (_m: string, _o?: unknown): Promise<string | null> => null),
  bindable: [] as Array<{ object: unknown; path: string; label: string }>,
}));

vi.mock("@api/objectFormat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/objectFormat")>()),
  commitObjectFormat: (changes: unknown, label?: string) => h.commit(changes, label),
  previewObjectFormat: (...a: unknown[]) => h.preview(...a),
}));
vi.mock("@api/objectGeometry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/objectGeometry")>()),
  commitObjectGeometry: (changes: unknown, label: string) => h.geometry(changes, label),
}));
vi.mock("@api/dialogs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/dialogs")>()),
  promptAsync: (m: string, o?: unknown) => h.prompt(m, o),
}));
vi.mock("@api/numberFormats", () => ({
  previewNumberFormat: async (code: string, n: number) => ({ display: `${code}|${n}` }),
  getRibbonNumberFormats: async () => [],
}));
// WP-D's widget, doubled: it records what it was given and shows the literal editor.
vi.mock("../../../_shared/components/bindings", () => ({
  BindableField: (props: { object: unknown; path: string; label: string; literal: React.ReactNode }) => {
    h.bindable.push({ object: props.object, path: props.path, label: props.label });
    return React.createElement("div", { "data-bindable-field": props.path }, props.literal);
  },
}));

import type { GridRegion } from "@api/gridOverlays";
import {
  registerObjectFormatProvider,
  resetObjectFormatProviders,
  type ContainerCapabilities,
  type DataFormatField,
  type ObjectFormatProvider,
} from "@api/objectFormat";
import { registerObjectGeometryProvider, resetObjectGeometryProviders } from "@api/objectGeometry";
import { registerLayoutSurfaceProvider, type LayoutSurface } from "@api/layoutSurface";
import { SIZE_AND_POSITION_UNDO_LABEL } from "@api/objectPosition";
import {
  BASE_CONTAINER_DEFAULTS,
  containerFieldPointer,
  type ContainerFieldId,
  type VisualContainerFormat,
} from "@api/visualContainer";
import { FormatTab } from "../components/FormatTab";
import { TITLE_RENAME_LABEL } from "../components/cards/TitleCard";
import { TITLE_IS_IDENTITY } from "../lib/formatValues";
import { floatingRegion } from "./harness";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const TYPE = "fake-visual";
const REGION: GridRegion = floatingRegion("v-1", TYPE, 40, 40, 200, 100);
const LOCK_SENTENCE = "The page's objects are locked. Turn off Lock Objects to move or size them.";
const REF = { kind: "chart" as const, id: "c1" };

const ALL: ContainerCapabilities = {
  padding: true,
  lockAspect: true,
  title: true,
  titleText: "free",
  subtitle: true,
  divider: true,
  background: true,
  backgroundTransparency: true,
  gradient: false,
  border: true,
  borderRadius: true,
  shadow: true,
  dataFormat: true,
};

let stored: VisualContainerFormat = {};
let caps: ContainerCapabilities = ALL;
let surface: LayoutSurface | null = null;
let bindable = new Set<ContainerFieldId>();
let dataFormats: DataFormatField[] = [];
const setDataFormat = vi.fn(async (_r: GridRegion, _k: string, _f: string | null) => {});
let container: HTMLDivElement;
let root: Root;
const cleanups: Array<() => void> = [];

function provider(): ObjectFormatProvider {
  return {
    types: [TYPE],
    read: () => stored,
    defaults: () => BASE_CONTAINER_DEFAULTS,
    capabilities: () => caps,
    commit: async () => {},
    bindingPath: (_r, field) => (bindable.has(field) ? `/container${containerFieldPointer(field)}` : null),
    bindingRef: async () => REF,
    dataFormats: async () => dataFormats,
    setDataFormat,
  };
}

async function render(region: GridRegion = REGION, readOnly = false): Promise<void> {
  await act(async () => {
    root.render(<FormatTab region={region} readOnly={readOnly} readOnlyReason={readOnly ? "Read only." : null} />);
  });
  // The binding ref and the data formats arrive asynchronously.
  await act(async () => {
    await Promise.resolve();
  });
}

function row(fieldId: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-field-id="${fieldId}"]`);
  if (!el) throw new Error(`no row ${fieldId}`);
  return el;
}

function input(fieldId: string): HTMLInputElement {
  return row(fieldId).querySelector<HTMLInputElement>(`[data-testid="format-${fieldId}"]`)!;
}

function setNativeValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Type into a box and leave it (focus, value, blur). */
function typeAndBlur(el: HTMLInputElement, value: string): void {
  act(() => {
    el.focus();
    setNativeValue(el, value);
  });
  act(() => {
    el.blur();
  });
}

function lastPatch(): unknown {
  const call = h.commit.mock.calls.at(-1);
  if (!call) return undefined;
  const changes = call[0] as Array<{ region: GridRegion; patch: unknown }>;
  expect(changes).toHaveLength(1);
  expect(changes[0].region.id).toBe(REGION.id);
  return changes[0].patch;
}

beforeEach(() => {
  stored = {};
  caps = ALL;
  surface = null;
  bindable = new Set();
  dataFormats = [];
  h.commit.mockClear();
  h.preview.mockClear();
  h.geometry.mockClear();
  h.prompt.mockReset();
  h.bindable = [];
  setDataFormat.mockClear();
  resetObjectFormatProviders();
  resetObjectGeometryProviders();
  cleanups.push(registerObjectFormatProvider(provider()));
  cleanups.push(registerObjectGeometryProvider({ types: [TYPE], commit: async () => {} }));
  cleanups.push(registerLayoutSurfaceProvider({ get: () => surface }));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  while (cleanups.length) cleanups.pop()!();
});

describe("General cards commit the right patch", () => {
  it("Effects: a toggle commits its leaf; a typed border colour commits on Enter", async () => {
    await render();
    act(() => input("shadow.show").click());
    expect(lastPatch()).toEqual({ shadow: { show: true } });

    const hex = row("border.color").querySelector<HTMLInputElement>('[data-testid="format-border.color-hex"]')!;
    act(() => {
      hex.focus();
      setNativeValue(hex, "#1F4E79");
    });
    act(() => {
      hex.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(lastPatch()).toEqual({ border: { color: "#1F4E79" } });
  });

  it("a toggle SHOWS its new value while a backend write is in flight, and the stored value once it settles", async () => {
    // Live 2026-10-16 (floating grid's title bar): the snapshot moves only when
    // the backend answers, so the controlled box bounced straight back and the
    // journey's uncheck read "did not change its state".
    let release: (() => void) | null = null;
    h.commit.mockImplementationOnce(
      (_changes: unknown, _label?: string) =>
        new Promise((resolve) => {
          release = () => resolve({ applied: 1, refused: [] });
        }),
    );
    await render();
    expect(input("shadow.show").checked).toBe(false);
    act(() => input("shadow.show").click());
    expect(lastPatch()).toEqual({ shadow: { show: true } });
    expect(input("shadow.show").checked, "ticked while the write is in flight").toBe(true);
    await act(async () => {
      release!();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    // The double stored nothing, so the stored value (off) is the truth again.
    expect(input("shadow.show").checked).toBe(false);
  });

  it("Properties: padding commits on blur, clamped into its range; an unchanged blur commits nothing", async () => {
    await render();
    typeAndBlur(input("padding.top"), "24");
    expect(lastPatch()).toEqual({ padding: { top: 24 } });

    h.commit.mockClear();
    typeAndBlur(input("padding.right"), "999");
    expect(lastPatch()).toEqual({ padding: { right: 200 } });

    h.commit.mockClear();
    typeAndBlur(input("padding.bottom"), "0"); // the default already shows 0
    expect(h.commit).not.toHaveBeenCalled();
  });

  it("Title: text commits the literal; a stored value cleared to blank goes back to the default (null)", async () => {
    stored = { title: { text: "Old" } };
    await render();
    typeAndBlur(input("title.text"), "Revenue by group");
    expect(lastPatch()).toEqual({ title: { text: "Revenue by group" } });
    typeAndBlur(input("title.text"), "");
    expect(lastPatch()).toEqual({ title: { text: null } });
  });

  it("Title: heading level commits a NUMBER", async () => {
    await render();
    const select = row("title.headingLevel").querySelector("select")!;
    act(() => {
      select.value = "2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(lastPatch()).toEqual({ title: { headingLevel: 2 } });
  });

  it("a transparency slider previews while it drags", async () => {
    await render();
    const slider = input("background.transparency");
    act(() => {
      setNativeValue(slider, "40");
    });
    expect(h.preview).toHaveBeenCalled();
    const [region, patch] = h.preview.mock.calls.at(-1)!;
    expect((region as GridRegion).id).toBe(REGION.id);
    expect(patch).toEqual({ background: { transparency: 40 } });
  });
});

describe("geometry vs format under Lock Objects", () => {
  it("geometry rows are disabled with the Lock Objects sentence; Effects stay enabled", async () => {
    surface = {
      snapToGrid: false,
      gridSize: 8,
      showGrid: false,
      page: { width: 1280, height: 720 },
      editable: true,
      pageLockedReason: LOCK_SENTENCE,
    };
    await render();
    for (const key of ["x", "y", "width", "height"]) {
      expect(
        row(`geometry.${key}`).querySelector<HTMLInputElement>(`[data-testid="format-geometry-${key}"]`)!.disabled,
      ).toBe(true);
    }
    expect(container.querySelector('[data-testid="object-pane-geometry-reason"]')!.textContent).toBe(LOCK_SENTENCE);
    expect(input("shadow.show").disabled).toBe(false);
    expect(input("padding.top").disabled).toBe(false);
    act(() => input("shadow.show").click());
    expect(lastPatch()).toEqual({ shadow: { show: true } });
  });

  it("Lock aspect ratio on: a Width commit also commits the Height by the ratio (one change)", async () => {
    stored = { lockAspect: true };
    await render();
    const width = row("geometry.width").querySelector<HTMLInputElement>('[data-testid="format-geometry-width"]')!;
    typeAndBlur(width, "300");
    expect(h.geometry).toHaveBeenCalledTimes(1);
    const [changes, label] = h.geometry.mock.calls[0];
    expect(label).toBe(SIZE_AND_POSITION_UNDO_LABEL);
    expect(changes).toHaveLength(1);
    const c = (changes as Array<{ width: number; height: number; x: number; y: number }>)[0];
    expect([c.x, c.y, c.width, c.height]).toEqual([40, 40, 300, 150]);
  });

  it("Lock aspect ratio off: a Width commit leaves the Height", async () => {
    await render();
    const width = row("geometry.width").querySelector<HTMLInputElement>('[data-testid="format-geometry-width"]')!;
    typeAndBlur(width, "300");
    const c = (h.geometry.mock.calls[0][0] as Array<{ width: number; height: number }>)[0];
    expect([c.width, c.height]).toEqual([300, 100]);
  });
});

describe("identity title, data format, bindings, capabilities", () => {
  it("an identity title is read-only with 'rename it'; Rename commits title.text as a rename", async () => {
    caps = { ...ALL, titleText: "identity" };
    stored = { title: { text: "Float1" } };
    h.prompt.mockResolvedValue("Float2");
    await render();
    expect(input("title.text").disabled).toBe(true);
    expect(container.querySelector('[data-testid="format-title-identity"]')!.textContent).toBe(TITLE_IS_IDENTITY);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="format-title-rename"]')!.click();
    });
    expect(h.commit).toHaveBeenCalledTimes(1);
    expect(h.commit.mock.calls[0][1]).toBe(TITLE_RENAME_LABEL);
    expect(lastPatch()).toEqual({ title: { text: "Float2" } });
  });

  it("Data format: 'Use source format' sets null; a preset sets its code", async () => {
    dataFormats = [{ key: "0", label: "Revenue", format: "#,##0.00", sourceFormat: "#,##0" }];
    await render();
    const r = row("dataFormat.0");
    expect(r.textContent).toContain("Revenue");
    await act(async () => {
      r.querySelector<HTMLButtonElement>('[data-testid="format-data-0-source"]')!.click();
    });
    expect(setDataFormat).toHaveBeenCalledWith(expect.objectContaining({ id: REGION.id }), "0", null);

    const select = r.querySelector<HTMLSelectElement>('[data-testid="format-data-0"]')!;
    await act(async () => {
      select.value = "0%";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(setDataFormat).toHaveBeenLastCalledWith(expect.objectContaining({ id: REGION.id }), "0", "0%");
  });

  it("a bindable row renders BindableField with the provider's ref + path; a non-bindable one does not", async () => {
    bindable = new Set<ContainerFieldId>(["border.color"]);
    await render();
    expect(row("border.color").getAttribute("data-bindable")).toBe("true");
    expect(row("border.width").getAttribute("data-bindable")).toBe("false");
    const seen = h.bindable.filter((b) => b.path === "/container/border/color");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)!.object).toEqual(REF);
    expect(h.bindable.some((b) => b.path === "/container/border/width")).toBe(false);
  });

  it("capabilities hide what the family does not offer", async () => {
    caps = { ...ALL, subtitle: false, divider: false, shadow: false, padding: false, borderRadius: false, dataFormat: false };
    await render();
    expect(container.querySelector('[data-field-id="subtitle.show"]')).toBeNull();
    expect(container.querySelector('[data-field-id="divider.show"]')).toBeNull();
    expect(container.querySelector('[data-field-id="shadow.show"]')).toBeNull();
    expect(container.querySelector('[data-field-id="padding.top"]')).toBeNull();
    expect(container.querySelector('[data-field-id="border.radius"]')).toBeNull();
    expect(container.querySelector('[data-format-card="dataFormat"]')).toBeNull();
    expect(container.querySelector('[data-field-id="title.show"]')).not.toBeNull();
    // A distance shows only beside the band it follows.
    expect(container.querySelector('[data-field-id="spacing.belowTitle"]')).not.toBeNull();
    expect(container.querySelector('[data-field-id="spacing.belowSubtitle"]')).toBeNull();
    expect(container.querySelector('[data-field-id="spacing.belowDivider"]')).toBeNull();
    expect(container.querySelector('[data-field-id="title.wrap"]')).not.toBeNull();
  });

  it("a one-line header shows no Wrap row; a family with no spacing shows no Spacing rows", async () => {
    caps = { ...ALL, subtitle: false, divider: false, titleWrap: false, spacing: false };
    await render();
    expect(container.querySelector('[data-field-id="title.show"]')).not.toBeNull();
    expect(container.querySelector('[data-field-id="title.fontSize"]')).not.toBeNull();
    expect(container.querySelector('[data-field-id="title.wrap"]')).toBeNull();
    expect(container.querySelector('[data-field-id="spacing.custom"]')).toBeNull();
    expect(container.querySelector('[data-field-id="spacing.belowTitle"]')).toBeNull();
  });

  it("a read-only (subscribed) page disables the format rows", async () => {
    await render(REGION, true);
    expect(input("shadow.show").disabled).toBe(true);
    act(() => input("shadow.show").click());
    expect(h.commit).not.toHaveBeenCalled();
  });
});
