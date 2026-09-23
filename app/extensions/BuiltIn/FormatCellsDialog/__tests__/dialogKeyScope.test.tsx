//! FILENAME: app/extensions/BuiltIn/FormatCellsDialog/__tests__/dialogKeyScope.test.tsx
// PURPOSE: The Format Cells dialog's Escape = Cancel and Enter = OK apply only
//          to keys that start inside the dialog's OWN DOM.
// CONTEXT: React bubbles key events through the component tree, so a key in a
//          surface the dialog portals to <body> (the colour palette, its hex
//          field) reached the dialog's onKeyDown: Escape to close the palette
//          cancelled the whole dialog, Enter in the hex field pressed OK. The
//          tab below portals an input to <body> the same way, so the test does
//          not depend on any one picker's own guard.

/* eslint-disable @typescript-eslint/naming-convention --
 * The module doubles below stand in for the six tab COMPONENTS, whose real
 * names are PascalCase, and set the DOM attribute `data-testid` by its real
 * spelling. */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const h = vi.hoisted(() => ({
  applyFormatting: vi.fn(),
  setCellProtection: vi.fn(),
  getCellProtection: vi.fn(),
  getCell: vi.fn(),
  emit: vi.fn(),
}));

vi.mock("@api", () => ({
  useGridState: () => ({ selection: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 } }),
  cellEvents: { emit: h.emit },
}));
vi.mock("@api/lib", () => ({
  getCell: (...a: unknown[]) => h.getCell(...a),
  getStyle: vi.fn(),
  applyFormatting: (...a: unknown[]) => h.applyFormatting(...a),
}));
vi.mock("@api/backend", () => ({
  setCellProtection: (...a: unknown[]) => h.setCellProtection(...a),
  getCellProtection: (...a: unknown[]) => h.getCellProtection(...a),
}));
vi.mock("@api/dialogs", () => ({ alertAsync: vi.fn() }));

// The first tab renders one input inside the dialog and one portalled to
// <body> — the shape of every popover the dialog hosts.
vi.mock("../tabs/NumberTab", async () => {
  const R = await import("react");
  const { createPortal } = await import("react-dom");
  return {
    NumberTab: () =>
      R.createElement(
        R.Fragment,
        null,
        R.createElement("input", { "data-testid": "in-dialog" }),
        createPortal(R.createElement("input", { "data-testid": "portalled" }), document.body),
      ),
  };
});
vi.mock("../tabs/AlignmentTab", () => ({ AlignmentTab: () => null }));
vi.mock("../tabs/FontTab", () => ({ FontTab: () => null }));
vi.mock("../tabs/BorderTab", () => ({ BorderTab: () => null }));
vi.mock("../tabs/FillTab", () => ({ FillTab: () => null }));
vi.mock("../tabs/ProtectionTab", () => ({ ProtectionTab: () => null }));

import { FormatCellsDialog } from "../FormatCellsDialog";
import { useFormatCellsStore } from "../hooks/useFormatCellsState";

// ============================================================================
// Harness
// ============================================================================

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  h.applyFormatting.mockReset();
  h.applyFormatting.mockResolvedValue({ cells: [] });
  h.setCellProtection.mockReset();
  h.setCellProtection.mockResolvedValue({ success: true });
  h.getCellProtection.mockReset();
  h.getCellProtection.mockResolvedValue({ locked: true, formulaHidden: false });
  h.getCell.mockReset();
  h.getCell.mockResolvedValue(null);
  useFormatCellsStore.getState().setActiveTab("number");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

async function renderDialog(onClose: () => void): Promise<void> {
  await act(async () => {
    root.render(<FormatCellsDialog isOpen onClose={onClose} />);
  });
  // Let the on-mount style load settle.
  await act(async () => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

async function press(el: Element, key: string): Promise<KeyboardEvent> {
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  await act(async () => {
    el.dispatchEvent(ev);
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  });
  return ev;
}

function byTestId(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-testid='${id}']`);
  if (!el) throw new Error(`no element for ${id}`);
  return el;
}

// ============================================================================
// Tests
// ============================================================================

describe("Format Cells dialog — Escape / Enter belong to the dialog's own DOM", () => {
  it("the portalled input really is outside the dialog's DOM (the premise)", async () => {
    await renderDialog(() => {});
    expect(container.contains(byTestId("in-dialog"))).toBe(true);
    expect(container.contains(byTestId("portalled"))).toBe(false);
  });

  it("Escape inside the dialog cancels it (positive control)", async () => {
    const onClose = vi.fn();
    await renderDialog(onClose);
    await press(byTestId("in-dialog"), "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(h.applyFormatting).not.toHaveBeenCalled();
  });

  it("Enter inside the dialog applies it (positive control)", async () => {
    const onClose = vi.fn();
    await renderDialog(onClose);
    await press(byTestId("in-dialog"), "Enter");
    expect(h.applyFormatting).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape in a portalled child does NOT cancel the dialog", async () => {
    const onClose = vi.fn();
    await renderDialog(onClose);
    await press(byTestId("portalled"), "Escape");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Enter in a portalled child does NOT press OK", async () => {
    const onClose = vi.fn();
    await renderDialog(onClose);
    await press(byTestId("portalled"), "Enter");
    expect(h.applyFormatting).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Escape from a portalled child still reaches the document, so a popover can close itself", async () => {
    await renderDialog(() => {});
    const heard = vi.fn();
    document.addEventListener("keydown", heard);
    try {
      await press(byTestId("portalled"), "Escape");
      expect(heard).toHaveBeenCalledTimes(1);
      // Other keys from the portalled child stay contained, as they always were.
      heard.mockClear();
      await press(byTestId("portalled"), "ArrowRight");
      expect(heard).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", heard);
    }
  });
});
