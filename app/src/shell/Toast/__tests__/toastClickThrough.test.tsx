//! FILENAME: app/src/shell/Toast/__tests__/toastClickThrough.test.tsx
// PURPOSE: A toast must never be a click surface over the grid — except its OK button.
//
// This is the SECOND half of a defect that was fixed once. `ToastContainer`
// already carries a comment explaining that a layout box at z-index 9999 over
// the grid swallows clicks, and it sets `pointerEvents: "none"` on the container
// for exactly that reason. The toast INSIDE it kept `pointerEvents: "auto"` on
// its whole 380x~58 box, so the defect survived at a smaller size and nobody
// noticed for as long as nothing clicked the bottom-right corner.
//
// MEASURED 2026-08-18, on the live app, not reasoned about:
// `app/e2e/tests/macro-live-edit.spec.ts` creates a button at P63, the product
// announces "Button created at P63", and the click 312 ms later never reaches
// the grid. The instrumentation added to that spec shows both halves at once:
//
//     product hit test: HIT button id=control-0-62-15 at r62c15
//     topmost element:  <div>  COVERED BY: [data-toast] "Button created at P63 ..."
//
// i.e. the click was DELIVERABLE and was eaten by the announcement of the very
// thing being clicked. A/B on that spec: without dismissing the toast, 1 failed
// / 4 passed; with it, 5 passed.
//
// Note this is a real USER defect, not only a test one: any control in the
// bottom-right of the grid is dead for the 5 seconds a toast lives.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ToastContainer } from "../Toast";
import { useToastStore } from "../useToastStore";

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
  useToastStore.setState({ toasts: [] });
});

/** Put one toast on screen through the REAL store, the way the app does. */
function renderOneToast(message = "Button created at P63"): void {
  useToastStore.setState({
    toasts: [{ id: "t1", message, variant: "success", duration: 5000 }],
  });
  act(() => {
    root.render(<ToastContainer />);
  });
}

function toastEl(): HTMLElement {
  const el = container.querySelector("[data-toast]") as HTMLElement | null;
  if (!el) throw new Error("no toast rendered — every assertion here would be vacuous");
  return el;
}

describe("a toast is not a click surface", () => {
  it("the toast BODY is click-through", () => {
    renderOneToast();
    expect(
      toastEl().style.pointerEvents,
      "the toast body is a click surface again: a 380px box at z-index 9999 over " +
        "the bottom-right of the grid eats every click for the 5 seconds it lives. " +
        "This is the defect measured on 2026-08-18 in macro-live-edit.spec.ts.",
    ).toBe("none");
  });

  it("the OK button IS a surface, or the toast cannot be dismissed", () => {
    // The other direction. `pointerEvents: "none"` on the body is only safe
    // because the button re-enables it; drop that and the toast becomes
    // undismissable, which is a worse defect than the one being fixed.
    renderOneToast();
    const ok = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "OK",
    );
    expect(ok, "the OK button is gone — the toast has no dismiss affordance").toBeTruthy();
    expect(
      ok!.style.pointerEvents,
      "the OK button no longer re-enables pointer events, so with a click-through " +
        "body the toast can never be dismissed by clicking",
    ).toBe("auto");
  });

  it("the CONTAINER stays click-through too — both halves or neither", () => {
    // Non-vacuity for the pair above: the original fix was on the container, and
    // a regression reverting THAT would reintroduce the same swallowing at a
    // larger size (the union of every stacked toast, plus the 8px gaps between).
    renderOneToast();
    const box = toastEl().parentElement as HTMLElement;
    expect(
      box.style.pointerEvents,
      "the toast CONTAINER is a click surface again — see its own comment",
    ).toBe("none");
    expect(box.style.position, "the container is still the fixed overlay").toBe("fixed");
    expect(box.style.zIndex, "the container still sits above the grid").toBe("9999");
  });
});
