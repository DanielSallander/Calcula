//! FILENAME: app/extensions/_shared/components/__tests__/editorStyles.test.tsx
// PURPOSE: The shared field-editor chrome (EditorStyles.ts + FieldList.tsx,
//          used by the Pivot field editor) paints with theme
//          tokens only — no Primer hex literal survives, in any state class
//          (hover, dragging, drag-over, selected) — so the editors follow the
//          Dark skin and an organisation's skin like the rest of the chrome.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  SurfaceLayoutProvider,
  bandLayout,
  panelLayout,
  findHardcodedColours,
  type SurfaceLayout,
} from "@api/layout";
import { styles } from "../EditorStyles";
import { FieldList } from "../FieldList";
import type { SourceField } from "../types";

const LAYOUTS: Array<[string, SurfaceLayout]> = [
  ["band", bandLayout()],
  ["panel", panelLayout(300)],
];

const FIELDS: SourceField[] = [
  { index: 0, name: "Region", isNumeric: false },
  { index: 1, name: "Sales", isNumeric: true },
  { index: 2, name: "Units", isNumeric: true },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

function render(node: React.ReactNode, layout: SurfaceLayout): void {
  act(() => {
    root.render(<SurfaceLayoutProvider value={layout}>{node}</SurfaceLayoutProvider>);
  });
}

/** Every modifier class the editors toggle on these styles. */
const MODIFIERS = ["dragging", "drag-over", "full-width", "selected"];

describe("shared field-editor chrome paints with tokens only", () => {
  it.each(LAYOUTS)("FieldList renders no hardcoded colour in the %s layout", (_n, layout) => {
    render(
      <FieldList
        fields={FIELDS}
        usedFields={new Set([1])}
        onFieldToggle={vi.fn()}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
      />,
      layout,
    );
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(FIELDS.length);
    expect(findHardcodedColours(container)).toEqual([]);
  });

  it.each(LAYOUTS)("every EditorStyles class, in every state, is token-only (%s layout)", (_n, layout) => {
    render(
      <div>
        {Object.entries(styles).map(([name, cls]) => (
          <div key={name} className={`${cls} ${MODIFIERS.join(" ")}`} data-style={name}>
            <input type="checkbox" readOnly checked />
            <select defaultValue="a">
              <option value="a">a</option>
            </select>
          </div>
        ))}
      </div>,
      layout,
    );
    expect(container.querySelectorAll("[data-style]").length).toBe(Object.keys(styles).length);
    expect(findHardcodedColours(container)).toEqual([]);
  });

  it("the search box still filters and reports no match", () => {
    render(
      <FieldList
        fields={FIELDS}
        usedFields={new Set()}
        onFieldToggle={vi.fn()}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
      />,
      panelLayout(300),
    );
    const search = container.querySelector<HTMLInputElement>('input[type="text"]')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(search, "zzz");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain('No fields match "zzz"');
    expect(findHardcodedColours(container)).toEqual([]);
  });
});
