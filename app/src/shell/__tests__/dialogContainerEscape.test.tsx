//! FILENAME: app/src/shell/__tests__/dialogContainerEscape.test.tsx
// PURPOSE: The dialog host's capture-phase Escape must leave a popover's
//          Escape to the popover.
// CONTEXT: DialogContainer closes the topmost dialog on a window CAPTURE
//          keydown, which runs before any listener the dialog or its popovers
//          own. Pressing Escape to dismiss the Format Cells colour palette
//          therefore closed the whole dialog (without its reset()). Every
//          @api/layout overlay is portalled into a `[data-section-flyout]`, so
//          an Escape whose target is inside one is the popover's.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import ReactDOM from "react-dom";
import { createRoot, type Root } from "react-dom/client";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const closeDialog = vi.fn();

function FakeDialog(): React.ReactElement {
  return (
    <div>
      <button data-testid="in-dialog">OK</button>
      {ReactDOM.createPortal(
        <div data-section-flyout="">
          <input data-testid="in-flyout" />
        </div>,
        document.body,
      )}
    </div>
  );
}

vi.mock("../../api/ui", () => ({
  DialogExtensions: {
    onChange: () => () => {},
    getVisibleDialogs: () => [
      { definition: { id: "fake.dialog", component: FakeDialog }, data: undefined },
    ],
    closeDialog: (id: string) => closeDialog(id),
  },
}));

import { DialogContainer } from "../DialogContainer";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  closeDialog.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<DialogContainer />);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function byTestId(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`no [data-testid="${id}"]`);
  return el;
}

function pressEscapeOn(el: Element): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
}

describe("DialogContainer Escape", () => {
  it("closes the top dialog when Escape comes from the dialog itself", () => {
    pressEscapeOn(byTestId("in-dialog"));
    expect(closeDialog).toHaveBeenCalledWith("fake.dialog");
  });

  it("leaves Escape to a popover the dialog opened (target inside [data-section-flyout])", () => {
    pressEscapeOn(byTestId("in-flyout"));
    expect(closeDialog).not.toHaveBeenCalled();
  });
});
