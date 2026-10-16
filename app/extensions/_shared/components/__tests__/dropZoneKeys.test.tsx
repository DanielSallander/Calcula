//! FILENAME: app/extensions/_shared/components/__tests__/dropZoneKeys.test.tsx
// PURPOSE: The shared drop zones' KEYS (WP-C S9b). A chart's wells share
//          DropZoneTypes (a gauge's four slots are all "values"), so a zone
//          may register under its own `dropKey`, and its pills carry it as
//          `fromKey`. Pinned here:
//            - a pill from a keyed zone dragged out into empty space never
//              reaches the ONE drag-out callback (the pivot editor's): it
//              would remove the pivot field at the same zone and index;
//            - a zone without a key behaves exactly as before (positive
//              control: the callback fires);
//            - an unmounting zone deletes only its OWN registration.
// CONTEXT: jsdom has no layout: every element measures 0x0 at the origin, so
//          a release at (500, 500) is over no zone at all.

import { describe, it, expect, vi, afterEach } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { DropZone } from "../DropZone";
import { registerDragOutRemoval } from "../useDragDrop";
import type { DragField, ZoneField } from "../types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let unregister: (() => void) | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  unregister?.();
  unregister = null;
});

const FIELD: ZoneField = { sourceIndex: -1, name: "[Revenue]", isNumeric: true, customName: "[Revenue]" };
const noop = () => {};

function mount(element: React.ReactElement): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(element));
  return host;
}

function zone(dropKey: string | undefined, onDrop = vi.fn()): React.ReactElement {
  return (
    <DropZone
      zone="values"
      dropKey={dropKey}
      title="Values"
      fields={[FIELD]}
      onDrop={onDrop}
      onRemove={noop}
      onReorder={noop}
      onDragStart={noop}
      onDragEnd={noop}
    />
  );
}

function dragPillOut(container: HTMLElement): void {
  const pill = Array.from(container.querySelectorAll("span")).find((s) => s.textContent === "Revenue")!;
  act(() => {
    pill.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 0, clientY: 0 }));
  });
  act(() => {
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 500, clientY: 500 }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 500, clientY: 500 }));
  });
}

describe("keyed drop zones", () => {
  it("a pill from a KEYED zone dragged out never reaches the drag-out callback", () => {
    const removed = vi.fn<(f: DragField) => void>();
    unregister = registerDragOutRemoval(removed);
    const c = mount(zone("chart-well:target"));
    expect(c.querySelector("[data-drop-key='chart-well:target']")).toBeTruthy();
    dragPillOut(c);
    expect(removed).not.toHaveBeenCalled();
  });

  it("POSITIVE CONTROL: a pill from an unkeyed zone (the pivot editor) still does", () => {
    const removed = vi.fn<(f: DragField) => void>();
    unregister = registerDragOutRemoval(removed);
    const c = mount(zone(undefined));
    dragPillOut(c);
    expect(removed).toHaveBeenCalledTimes(1);
    expect(removed.mock.calls[0][0]).toMatchObject({ fromZone: "values", fromIndex: 0 });
    expect("fromKey" in removed.mock.calls[0][0]).toBe(false);
  });

  it("an unmounting zone deletes only its OWN registration (a later zone of the same key keeps working)", () => {
    // The detector: a release over NO zone sends an unkeyed pill to the
    // drag-out callback. A release over a LIVE zone does not.
    const removed = vi.fn<(f: DragField) => void>();
    unregister = registerDragOutRemoval(removed);
    const first = mount(zone(undefined));
    // A second, independent tree registers the same key ("values") after the first.
    const host2 = document.createElement("div");
    document.body.appendChild(host2);
    const root2 = createRoot(host2);
    act(() => root2.render(zone(undefined)));
    // The FIRST unmounts: the second's registration must survive it.
    act(() => root!.unmount());
    root = null;
    first.remove();
    const target = host2.firstElementChild as HTMLElement;
    target.getBoundingClientRect = () =>
      ({ left: 10, top: 10, right: 100, bottom: 50, width: 90, height: 40, x: 10, y: 10, toJSON: () => ({}) }) as DOMRect;
    const pill = Array.from(host2.querySelectorAll("span")).find((x) => x.textContent === "Revenue")!;
    act(() => {
      pill.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 0, clientY: 0 }));
    });
    act(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 50, clientY: 30 }));
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 50, clientY: 30 }));
    });
    // Released over the live second zone: found, so never a drag-out.
    expect(removed).not.toHaveBeenCalled();
    act(() => root2.unmount());
    host2.remove();
  });

  it("a keyed pill carries its zone's key as fromKey", () => {
    const onDrop = vi.fn();
    // Two zones of ONE type, each under its own key; drop the first's pill on the second.
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root!.render(
        <>
          {zone("chart-well:value")}
          <DropZone
            zone="values"
            dropKey="chart-well:target"
            title="Target"
            fields={[]}
            onDrop={onDrop}
            onRemove={noop}
            onReorder={noop}
            onDragStart={noop}
            onDragEnd={noop}
          />
        </>,
      ),
    );
    const target = host.querySelector("[data-drop-key='chart-well:target']") as HTMLElement;
    target.getBoundingClientRect = () =>
      ({ left: 10, top: 10, right: 100, bottom: 50, width: 90, height: 40, x: 10, y: 10, toJSON: () => ({}) }) as DOMRect;
    const pill = Array.from(host.querySelectorAll("span")).find((s) => s.textContent === "Revenue")!;
    act(() => {
      pill.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 0, clientY: 0 }));
    });
    act(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 50, clientY: 30 }));
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 50, clientY: 30 }));
    });
    // Same TYPE, different key: a move into the target, never a reorder.
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop.mock.calls[0][1]).toMatchObject({ fromZone: "values", fromIndex: 0, fromKey: "chart-well:value" });
  });
});
