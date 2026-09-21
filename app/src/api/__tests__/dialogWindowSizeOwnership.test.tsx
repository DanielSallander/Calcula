//! FILENAME: app/src/api/__tests__/dialogWindowSizeOwnership.test.tsx
// PURPOSE: Moving a dialog must not pin its SIZE.
// CONTEXT: `useDialogWindow` materialised the whole rect — left, top, width AND
//          height — on the first interaction of either kind. So dragging a
//          dialog aside froze its width, and every dialog whose CSS width
//          depends on its mode silently lost the wider layout: Publish's
//          620 -> 1040 on push, Subscribe's 560 -> 900 on the review step,
//          Refresh Preview's 520 -> 940 once there are conflicts. The user drags
//          the window somewhere convenient, advances a step, and the two-column
//          layout they were supposed to get never appears.
//
//          Position and size are now owned separately: a move emits position
//          only and leaves the CSS deciding the size; a resize takes both. The
//          one exception is a dialog the hook has to POP OUT of a flex backdrop
//          — it was sized by the flex container, so going `position: fixed` with
//          no width would shrink it to fit. Those keep today's behaviour.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useDialogWindow, type DialogWindowApi } from "../dialogWindow";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** A dialog box that is already `position: fixed`, as the hook's header requires. */
function Harness({
  onApi,
  position = "fixed",
}: {
  onApi: (api: DialogWindowApi) => void;
  position?: string;
}): React.ReactElement {
  const win = useDialogWindow({ minWidth: 100, minHeight: 100 });
  onApi(win);
  return (
    <div
      ref={win.ref}
      data-testid="box"
      style={{ position: position as React.CSSProperties["position"], ...win.style }}
    >
      <div data-testid="header" onMouseDown={win.onHeaderMouseDown}>
        title
      </div>
      {win.resizeHandles}
    </div>
  );
}

const box = () => container.querySelector('[data-testid="box"]') as HTMLElement;

function press(el: Element, x = 40, y = 40): void {
  act(() => {
    el.dispatchEvent(
      new MouseEvent("mousedown", { button: 0, clientX: x, clientY: y, bubbles: true }),
    );
  });
}

function release(): void {
  act(() => document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })));
}

describe("useDialogWindow: size ownership is separate from position ownership", () => {
  it("a MOVE emits position but leaves width/height to the CSS", () => {
    let api!: DialogWindowApi;
    act(() => root.render(<Harness onApi={(a) => (api = a)} />));

    press(container.querySelector('[data-testid="header"]')!);
    act(() => {
      document.dispatchEvent(
        new MouseEvent("mousemove", { clientX: 140, clientY: 90, bubbles: true }),
      );
    });
    release();

    // Position is owned...
    expect(api.style.position).toBe("fixed");
    expect(api.style.left).toBeTypeOf("number");
    expect(api.style.top).toBeTypeOf("number");
    expect(api.style.transform).toBe("none");

    // ...the size is NOT. This is the regression: emitting these froze every
    // mode-dependent dialog at whatever width it was dragged from.
    expect(api.style.width, "a move must not pin the width").toBeUndefined();
    expect(api.style.height, "a move must not pin the height").toBeUndefined();
    expect(api.style.maxWidth, "a move must not lift the max-width cap").toBeUndefined();
    expect(api.style.maxHeight).toBeUndefined();
  });

  it("a RESIZE takes the size, and lifts the caps that would fight it", () => {
    let api!: DialogWindowApi;
    act(() => root.render(<Harness onApi={(a) => (api = a)} />));

    // The 8 resize handles are the box's trailing children.
    const handles = [...box().children].filter(
      (c) => (c as HTMLElement).style.cursor?.includes("resize"),
    );
    expect(handles.length, "the hook should render 8 resize handles").toBe(8);

    press(handles[0]);
    act(() => {
      document.dispatchEvent(
        new MouseEvent("mousemove", { clientX: 40, clientY: 200, bubbles: true }),
      );
    });
    release();

    expect(api.style.width, "a resize owns the width").toBeTypeOf("number");
    expect(api.style.height).toBeTypeOf("number");
    expect(api.style.maxWidth).toBe("none");
    expect(api.style.maxHeight).toBe("none");
  });

  it("a move AFTER a resize keeps the size the user chose", () => {
    let api!: DialogWindowApi;
    act(() => root.render(<Harness onApi={(a) => (api = a)} />));

    const handles = [...box().children].filter(
      (c) => (c as HTMLElement).style.cursor?.includes("resize"),
    );
    press(handles[0]);
    act(() => {
      document.dispatchEvent(
        new MouseEvent("mousemove", { clientX: 40, clientY: 260, bubbles: true }),
      );
    });
    release();
    expect(api.style.height).toBeTypeOf("number");

    // Ownership is sticky: dragging the window somewhere else must not hand the
    // size back to the CSS and snap a deliberately resized dialog shut.
    press(container.querySelector('[data-testid="header"]')!);
    act(() => {
      document.dispatchEvent(
        new MouseEvent("mousemove", { clientX: 300, clientY: 300, bubbles: true }),
      );
    });
    release();
    expect(api.style.width, "a later move must not give the size back").toBeTypeOf("number");
    expect(api.style.height).toBeTypeOf("number");
  });

  it("a box the hook pops OUT of a flex backdrop keeps its measured size", () => {
    // It was laid out by the flex container, so `position: fixed` with no width
    // would shrink it to fit. Those dialogs keep the old behaviour.
    let api!: DialogWindowApi;
    act(() => root.render(<Harness position="static" onApi={(a) => (api = a)} />));

    press(container.querySelector('[data-testid="header"]')!);
    act(() => {
      document.dispatchEvent(
        new MouseEvent("mousemove", { clientX: 140, clientY: 90, bubbles: true }),
      );
    });
    release();

    expect(api.style.width, "a popped-out flex child must keep its size").toBeTypeOf("number");
    expect(api.style.height).toBeTypeOf("number");
  });

  it("reset() hands both position and size back to the CSS", () => {
    let api!: DialogWindowApi;
    act(() => root.render(<Harness onApi={(a) => (api = a)} />));

    const handles = [...box().children].filter(
      (c) => (c as HTMLElement).style.cursor?.includes("resize"),
    );
    press(handles[0]);
    act(() => {
      document.dispatchEvent(
        new MouseEvent("mousemove", { clientX: 40, clientY: 260, bubbles: true }),
      );
    });
    release();
    expect(api.style.width).toBeTypeOf("number");

    act(() => api.reset());
    expect(api.style).toEqual({});
  });
});
