//! FILENAME: app/extensions/Controls/PropertiesPane/__tests__/pageNavigatorButtonsBinding.test.tsx
// PURPOSE: Per-button bindings in the Page Navigator's "Buttons" section
//          (WP-D S8d, D §3.18a):
//            * with the navigator's binding ref, each page's caption and colour
//              inputs sit in a BindableField whose pointer names the PAGE
//              (`/properties/pageOverrides/<sheetId>/<field>`), never an index;
//            * `=...` in a caption's fx editor calls setBinding with that
//              pointer and NEVER the section's literal write;
//            * a page with no id is addressed `name:<sheet>`, RFC 6901-escaped;
//            * no fx without a ref (no uid) or on a read-only navigator.
// CONTEXT: react-dom + act; `@api/objectBindings` is real except the
//          operations that reach the backend and the cache read; the page list
//          is a doubled @api/reportPages snapshot.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReportPage } from "@api/reportPages";
import type { ObjectBindingRef } from "@api/objectBindings";

const h = vi.hoisted(() => ({
  snapshot: null as unknown,
  setBinding: vi.fn(),
  writes: [] as unknown[],
}));

vi.mock("@api/reportPages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/reportPages")>()),
  getReportPagesSnapshot: () => h.snapshot,
  onReportPagesChanged: () => () => {},
}));
vi.mock("@api/objectBindings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@api/objectBindings")>()),
  getBinding: () => null,
  setBinding: (...a: unknown[]) => h.setBinding(...a),
  clearBinding: async () => true,
  analyzeBindingFormula: async () => ({ error: null, warning: null }),
  listBindingMeasures: async () => [],
  onBindingsChanged: () => () => {},
}));

import { PageNavigatorButtonsSection } from "../PageNavigatorButtonsSection";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const REF: ObjectBindingRef = { kind: "control", id: "nav-uid-1" };
const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;

function page(index: number, name: string, sheetId = `id-${index}`): ReportPage {
  return { sheetId, name, index, visibility: "visible", isTooltipPage: false };
}

function useCanvases(pages: ReportPage[]): void {
  h.snapshot = { pages, sheetIdByIndex: new Map(pages.map((p) => [p.index, p.sheetId])), activeIndex: 1, version: 1 };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  h.setBinding.mockReset();
  h.writes = [];
  useCanvases([page(1, "Overview"), page(2, "Sales")]);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
});

async function render(bindingRef: ObjectBindingRef | null, readOnly = false): Promise<void> {
  await act(async () => {
    root.render(
      <PageNavigatorButtonsSection
        controlId="control-2-1-1"
        properties={{}}
        readOnly={readOnly}
        onWrite={async (list) => {
          h.writes.push(list);
        }}
        bindingRef={bindingRef}
      />,
    );
  });
}

async function expand(key: string): Promise<void> {
  const row = host.querySelector<HTMLButtonElement>(`[data-testid="nav-buttons-row-${key}"]`)!;
  await act(async () => {
    row.click();
  });
}

const fieldPaths = () =>
  Array.from(host.querySelectorAll("[data-bindable-field]")).map((e) => e.getAttribute("data-bindable-field"));

describe("per-button fx", () => {
  // SABOTAGE (run 2026-10-15, bit): key the pointer by an index
  // (`pageButtonPointer("0", field)`) -- the paths name "0" and three tests fail.
  it("each caption and colour binds at a pointer keyed by the page's sheetId", async () => {
    await render(REF);
    await expand("id-2");
    expect(fieldPaths()).toEqual([
      "/properties/pageOverrides/id-2/text",
      "/properties/pageOverrides/id-2/fill",
      "/properties/pageOverrides/id-2/color",
      "/properties/pageOverrides/id-2/borderColor",
    ]);
  });

  it("'=' in a caption's fx editor calls setBinding with the page's pointer, never the literal write", async () => {
    h.setBinding.mockImplementation(async (object: unknown, path: string, formula: string) => ({
      object,
      path,
      formula,
      displayFormula: formula,
      model: null,
      resolved: null,
    }));
    await render(REF);
    await expand("id-2");
    const caption = host.querySelector('[data-bindable-field="/properties/pageOverrides/id-2/text"]')!;
    await act(async () => {
      caption.querySelector<HTMLButtonElement>("[data-bindable-fx]")!.click();
    });
    const input = caption.querySelector<HTMLInputElement>("[data-binding-formula-input]")!;
    await act(async () => {
      input.focus();
      setter.call(input, "=Inputs!A1");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });
    expect(h.setBinding).toHaveBeenCalledTimes(1);
    expect(h.setBinding.mock.calls[0].slice(0, 3)).toEqual([REF, "/properties/pageOverrides/id-2/text", "=Inputs!A1"]);
    expect(h.writes, "a binding is not a pageOverrides write").toEqual([]);
  });

  it("a page with no id is addressed by name, RFC 6901-escaped", async () => {
    useCanvases([page(1, "Q1/Q2", "")]);
    await render(REF);
    await expand("name:Q1/Q2");
    expect(fieldPaths()[0]).toBe("/properties/pageOverrides/name:Q1~1Q2/text");
  });

  it("no fx without the navigator's ref, or while it is read-only; the literal inputs stay", async () => {
    await render(null);
    await expand("id-2");
    expect(host.querySelector("[data-bindable-fx]")).toBeNull();
    expect(host.querySelector('[data-testid="nav-buttons-caption-id-2"]')).not.toBeNull();

    await render(REF, true);
    expect(host.querySelector("[data-bindable-fx]")).toBeNull();
    expect(host.querySelector('[data-testid="nav-buttons-fill-id-2"]')).not.toBeNull();
  });
});
