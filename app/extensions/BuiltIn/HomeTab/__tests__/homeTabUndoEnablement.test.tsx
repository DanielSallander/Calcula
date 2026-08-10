//! FILENAME: app/extensions/BuiltIn/HomeTab/__tests__/homeTabUndoEnablement.test.tsx
// PURPOSE: The ribbon's Undo and Redo buttons are greyed out when there is
//          nothing to undo or redo, and ONLY those two are.
// CONTEXT: Measured 2026-08-10 (register §3ax(1)): the Home tab rendered
//          undo/redo as plain <Button>s with no binding to `get_undo_state`,
//          so the app permanently invited a press it might not honour. Excel
//          greys them; the owner's standing rule is Excel parity.
//
//          The counterweight — that a neighbouring button is untouched — is
//          the half that keeps this from passing on a component that disables
//          everything.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// --- Mocks: keep the test on the enablement, not on the whole @api graph -----

const availability = { canUndo: false, canRedo: false };

vi.mock("@api/undoState", () => ({
  useUndoAvailability: () => availability,
}));

vi.mock("@api/ui", () => ({
  DialogExtensions: { openDialog: vi.fn() },
}));

const handleItemClick = vi.fn();
vi.mock("../components/useHomeTabState", () => ({
  useHomeTabState: () => ({
    currentStyle: null,
    currentCellData: null,
    handleItemClick,
    handleColorSelect: vi.fn(),
    handleCellStyleApply: vi.fn(),
    handleFontFamilyChange: vi.fn(),
    handleFontSizeChange: vi.fn(),
    handleNumberFormatChange: vi.fn(),
    isActive: () => false,
    getCurrentColor: () => "#000000",
    applyFormat: vi.fn(),
    getItemById: vi.fn(),
  }),
}));

// The icon set hangs off the @api barrel, which reaches every extension.
vi.mock("../components/homeTabIcons", () => ({
  homeTabIcon: () => null,
}));

vi.mock("../../../_shared/components/CellStylesGallery", () => ({
  CellStylesGallery: () => null,
}));

import { HomeTabGroupComponent } from "../components/HomeTabGroupComponent";

// --- Harness ----------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

async function render(itemIds: string[]): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(HomeTabGroupComponent, {
        context: {} as never,
        itemIds,
      }),
    );
  });
}

/** The rendered button for one Home tab item id. */
function button(itemId: string): HTMLButtonElement {
  const node = container.querySelector<HTMLButtonElement>(
    `[data-testid="fmt-${itemId}"]`,
  );
  expect(node, `no button rendered for "${itemId}"`).toBeTruthy();
  return node as HTMLButtonElement;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  handleItemClick.mockReset();
  availability.canUndo = false;
  availability.canRedo = false;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Home tab Undo/Redo enablement", () => {
  it("greys BOTH out when the stack is empty", async () => {
    await render(["undo", "redo", "find"]);

    expect(button("undo").disabled).toBe(true);
    expect(button("redo").disabled).toBe(true);
  });

  it("leaves a neighbouring button alone", async () => {
    // Without this the test would pass just as happily on a component that
    // disabled the whole group.
    await render(["undo", "redo", "find"]);

    expect(button("find").disabled).toBe(false);
    expect(button("find").hasAttribute("aria-disabled")).toBe(false);
  });

  it("enables Undo alone when only undo is available", async () => {
    availability.canUndo = true;
    await render(["undo", "redo"]);

    expect(button("undo").disabled).toBe(false);
    expect(button("redo").disabled).toBe(true);
  });

  it("enables Redo alone after an undo", async () => {
    availability.canUndo = false;
    availability.canRedo = true;
    await render(["undo", "redo"]);

    expect(button("undo").disabled).toBe(true);
    expect(button("redo").disabled).toBe(false);
  });

  it("a disabled Undo does not dispatch the command", async () => {
    await render(["undo"]);

    await act(async () => {
      button("undo").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // The real point of the disabled attribute rather than a cosmetic style:
    // the press must not reach the handler at all.
    expect(handleItemClick).not.toHaveBeenCalled();
  });

  it("an enabled Undo still dispatches", async () => {
    availability.canUndo = true;
    await render(["undo"]);

    await act(async () => {
      button("undo").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(handleItemClick).toHaveBeenCalledTimes(1);
    expect(handleItemClick.mock.calls[0][0]).toMatchObject({ id: "undo" });
  });

  it("announces the state to assistive technology, not only visually", async () => {
    await render(["undo"]);
    expect(button("undo").getAttribute("aria-disabled")).toBe("true");
  });
});
