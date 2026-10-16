//! FILENAME: app/extensions/FloatingRange/components/__tests__/FloatingRangePropertiesBody.test.tsx
// PURPOSE: The object pane's Properties tab for a floating grid (WP-C S12):
//          rows / columns commit on Enter or blur as ONE patch each (nothing
//          when unchanged, clamped to the backend bounds), the header strips on
//          click; a range its canvas LOCKS freezes the counts but not the
//          strips (chrome is formatting); a subscribed page freezes all; the
//          name and the title bar are NOT here (they are Format > Title). And
//          the provider: one Properties tab, the "Floating range - <name>"
//          header.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FloatingRangePropertiesBody, FR_PROPERTIES_LOCKED } from "../FloatingRangePropertiesBody";
import { createFrObjectPaneProvider } from "../../lib/frObjectPane";
import {
  FLOATING_RANGE_REGION_TYPE,
  resetFloatingRangeStore,
  upsertFromInfo,
} from "../../lib/floatingRangeStore";
import { registerLayoutSurfaceProvider } from "@api/layoutSurface";
import type { FloatingRangeInfo, FloatingRangePatch } from "@api/floatingRanges";
import type { GridRegion } from "@api/gridOverlays";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const FR_ID = "fr-props";

const INFO: FloatingRangeInfo = {
  id: FR_ID,
  backingSheetId: "backing",
  hostSheetId: "host",
  x: 10,
  y: 10,
  rotation: 0,
  pinToGrid: false,
  rowCount: 4,
  colCount: 3,
  colWidths: {},
  rowHeights: {},
  showTitle: true,
  showColumnHeaders: true,
  showRowHeaders: true,
  name: "Float5",
  backingSheetIndex: 1,
  hostSheetIndex: 0,
};

let host: HTMLDivElement;
let root: Root;
let unregisterSurface: (() => void) | null = null;
const writes: Array<[string, FloatingRangePatch]> = [];
const apply = vi.fn(async (id: string, patch: FloatingRangePatch) => {
  writes.push([id, patch]);
});

function mount(props: { readOnly?: boolean; readOnlyReason?: string | null } = {}): void {
  act(() => {
    root.render(
      <FloatingRangePropertiesBody
        frId={FR_ID}
        readOnly={props.readOnly ?? false}
        readOnlyReason={props.readOnlyReason ?? null}
        apply={apply}
      />,
    );
  });
}

function q<T extends HTMLElement>(testId: string): T {
  const el = host.querySelector(`[data-testid="${testId}"]`);
  if (!el) throw new Error(`no ${testId}`);
  return el as T;
}

function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

function lockPage(): void {
  unregisterSurface = registerLayoutSurfaceProvider({
    get: (i) =>
      i === 0
        ? {
            snapToGrid: false,
            gridSize: 16,
            showGrid: false,
            page: { width: 1280, height: 720 },
            editable: true,
            pageLockedReason: "The objects on this page are locked.",
          }
        : null,
  });
}

beforeEach(() => {
  writes.length = 0;
  apply.mockClear();
  resetFloatingRangeStore();
  upsertFromInfo(INFO);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  unregisterSurface?.();
  unregisterSurface = null;
  resetFloatingRangeStore();
});

describe("the Properties tab", () => {
  it("rows commit on Enter as ONE patch; an unchanged value writes nothing; a value is clamped", async () => {
    mount();
    const rows = q<HTMLInputElement>("fr-properties-rows");
    expect(rows.value).toBe("4");
    type(rows, "6");
    act(() => {
      rows.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settle();
    expect(writes).toEqual([[FR_ID, { rowCount: 6 }]]);

    // The range still has 4 rows (the double wrote nothing): blur at 4 is no write.
    type(rows, "4");
    act(() => {
      rows.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await settle();
    expect(writes).toHaveLength(1);

    const cols = q<HTMLInputElement>("fr-properties-cols");
    type(cols, "100000");
    act(() => {
      cols.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await settle();
    expect(writes[1]).toEqual([FR_ID, { colCount: 256 }]);
  });

  it("a header strip commits on click", async () => {
    mount();
    act(() => q<HTMLInputElement>("fr-properties-row-headers").click());
    await settle();
    expect(writes).toEqual([[FR_ID, { showRowHeaders: false }]]);
  });

  it("a clicked strip SHOWS its new value while the write is in flight, and a refusal puts the stored value back", async () => {
    // Live 2026-10-16: the controlled checkbox bounced back to ticked until the
    // backend answered, so a click looked ignored and Playwright's uncheck read
    // "did not change its state".
    let release: (() => void) | null = null;
    apply.mockImplementationOnce(
      (id: string, patch: FloatingRangePatch) =>
        new Promise<void>((resolve) => {
          writes.push([id, patch]);
          release = resolve;
        }),
    );
    mount();
    const strip = q<HTMLInputElement>("fr-properties-row-headers");
    act(() => strip.click());
    await settle();
    expect(writes).toEqual([[FR_ID, { showRowHeaders: false }]]);
    expect(q<HTMLInputElement>("fr-properties-row-headers").checked, "unticked while the write is in flight").toBe(
      false,
    );
    await act(async () => {
      release!();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    // The double wrote nothing to the store, so the row's own value (true) is the truth again.
    expect(q<HTMLInputElement>("fr-properties-row-headers").checked).toBe(true);

    apply.mockImplementationOnce(async () => {
      throw new Error("The sheet is protected.");
    });
    act(() => q<HTMLInputElement>("fr-properties-column-headers").click());
    await settle();
    expect(q<HTMLInputElement>("fr-properties-column-headers").checked, "a refused write shows the stored value").toBe(
      true,
    );
  });

  it("does NOT offer the name or the title bar (they are Format > Title)", () => {
    mount();
    expect(host.querySelector("[data-fr-name-input]")).toBeNull();
    expect(host.querySelector("[data-fr-show-title]")).toBeNull();
    expect(q("fr-properties-name-hint").textContent).toContain("Format tab");
  });

  it("a LOCKED range: the counts freeze, the strips do not, and the tab says why", () => {
    lockPage();
    mount();
    expect(q<HTMLInputElement>("fr-properties-rows").disabled).toBe(true);
    expect(q<HTMLInputElement>("fr-properties-cols").disabled).toBe(true);
    expect((host.querySelector("fieldset") as HTMLFieldSetElement).disabled).toBe(false);
    expect(q("fr-properties-locked").textContent).toBe(FR_PROPERTIES_LOCKED);
  });

  it("a subscribed page (read-only): nothing is editable, and the pane's reason shows", () => {
    mount({ readOnly: true, readOnlyReason: "This page is subscribed." });
    expect(q<HTMLInputElement>("fr-properties-rows").disabled).toBe(true);
    expect((host.querySelector("fieldset") as HTMLFieldSetElement).disabled).toBe(true);
    expect(q("fr-properties-readonly").textContent).toBe("This page is subscribed.");
  });

  it("a refusal from the backend shows as the tab's error line", async () => {
    apply.mockImplementationOnce(async () => {
      throw new Error("The sheet is protected.");
    });
    mount();
    act(() => q<HTMLInputElement>("fr-properties-column-headers").click());
    await settle();
    expect(q("fr-properties-error").textContent).toBe("The sheet is protected.");
  });
});

describe("the object pane provider", () => {
  const region: GridRegion = {
    id: `fr-${FR_ID}`,
    type: FLOATING_RANGE_REGION_TYPE,
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    floating: { x: 10, y: 10, width: 100, height: 100 },
    data: { frId: FR_ID },
  };

  it("offers ONE build tab, Properties, and names the range in the header", () => {
    const p = createFrObjectPaneProvider(FLOATING_RANGE_REGION_TYPE, (id) => (id === FR_ID ? "Float5" : null));
    expect(p.types).toEqual([FLOATING_RANGE_REGION_TYPE]);
    expect(p.tabs(region).map((t) => [t.id, t.label])).toEqual([["properties", "Properties"]]);
    expect(p.headerOf!(region)).toBe("Floating range - Float5");
    expect(p.tabs({ ...region, data: {} })).toEqual([]);
  });
});
