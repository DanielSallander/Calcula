//! FILENAME: app/extensions/Settings/__tests__/KeybindingsPage.capture.test.tsx
// PURPOSE: The shortcut capture boxes in Settings > Keyboard shortcuts RECORD
//          the keys pressed in them -- an already-bound combination too --
//          instead of running whatever that combination is bound to.
// CONTEXT: BUG-0199 (K3). The capture box heard keys through React's
//          onKeyDown, but the keybinding dispatcher is a window CAPTURE
//          listener: it ran first, matched the combination and stopped it.
//          Pressing Ctrl+S to record "Ctrl+S" SAVED THE WORKBOOK and recorded
//          nothing; Ctrl+P opened print preview through Print's own
//          window listener. The page's own conflict test had to pick an
//          "editing"-context combination to get a keystroke through at all.
//          Runs the REAL page over the REAL registry and dispatcher.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { KeybindingsPage } from "../components/KeybindingsPage";
import { initKeybindings, getEffectiveCombo, resetAllKeybindings } from "@api/keybindings";
import { CommandRegistry } from "@api/commands";
import { panelLayout, SurfaceLayoutProvider } from "@api/layout";

initKeybindings();

let container: HTMLDivElement;
let root: Root;
const save = vi.fn();
/** Another window-CAPTURE key listener, registered after the dispatcher -- the
 *  shape of Print's Ctrl+P, File Explorer's Ctrl+Shift+E, Search's Ctrl+Shift+H. */
const extensionListener = vi.fn();

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  save.mockReset();
  extensionListener.mockReset();
  CommandRegistry.register("core.file.save", save);
  window.addEventListener("keydown", extensionListener, true);
  resetAllKeybindings();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  CommandRegistry.unregister("core.file.save");
  window.removeEventListener("keydown", extensionListener, true);
  resetAllKeybindings();
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <SurfaceLayoutProvider value={panelLayout(480)}>
        <KeybindingsPage />
      </SurfaceLayoutProvider>,
    );
  });
}

function rowOf(label: string): HTMLTableRowElement {
  const row = Array.from(container.querySelectorAll<HTMLTableRowElement>("tbody tr")).find(
    (tr) => tr.querySelector("td span")?.textContent === label,
  );
  if (!row) throw new Error(`no row ${label}`);
  return row;
}

function button(scope: ParentNode, text: string): HTMLButtonElement {
  const b = Array.from(scope.querySelectorAll("button")).find((el) => el.textContent === text);
  if (!b) throw new Error(`no button ${text}`);
  return b as HTMLButtonElement;
}

async function pressIn(el: HTMLElement, init: KeyboardEventInit): Promise<KeyboardEvent> {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    el.dispatchEvent(e);
  });
  return e;
}

async function editRow(label: string): Promise<HTMLDivElement> {
  await act(async () => {
    button(rowOf(label), "Edit").click();
  });
  const capture = rowOf(label).querySelector<HTMLDivElement>('div[tabindex="0"]');
  if (!capture) throw new Error("no capture box");
  return capture;
}

describe("the row capture box records an already-bound combination", () => {
  it("Ctrl+S in the capture box does NOT save, and is recorded", async () => {
    await render();
    const capture = await editRow("Copy");
    const e = await pressIn(capture, { key: "s", ctrlKey: true });
    expect(save, "Ctrl+S saved the workbook instead of being recorded").not.toHaveBeenCalled();
    expect(capture.textContent).toBe("Ctrl+S");
    expect(e.defaultPrevented).toBe(true);
  });

  it("no other window key listener hears a key being recorded (Print's Ctrl+P would open print preview)", async () => {
    await render();
    const capture = await editRow("Copy");
    await pressIn(capture, { key: "p", ctrlKey: true });
    expect(extensionListener, "an extension's own listener acted on a key being recorded").not.toHaveBeenCalled();
    expect(capture.textContent).toBe("Ctrl+P");
  });

  it("Accept remaps to the recorded combination", async () => {
    await render();
    const capture = await editRow("Copy");
    await pressIn(capture, { key: "s", ctrlKey: true });
    await act(async () => {
      button(rowOf("Copy"), "Accept").click();
    });
    expect(getEffectiveCombo("core.copy")).toBe("Ctrl+S");
  });

  it("once the box closes, the combination runs its command again", async () => {
    await render();
    const capture = await editRow("Copy");
    await pressIn(capture, { key: "Escape" });
    await pressIn(document.body, { key: "s", ctrlKey: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe("the Add Shortcut capture box records too", () => {
  it("Ctrl+S there does NOT save, and fills the box", async () => {
    await render();
    await act(async () => {
      button(container, "+ Add Shortcut").click();
    });
    const capture = Array.from(container.querySelectorAll<HTMLDivElement>('div[tabindex="0"]')).find((d) =>
      (d.textContent ?? "").includes("press a key combination"),
    )!;
    await act(async () => {
      capture.focus();
    });
    await pressIn(capture, { key: "s", ctrlKey: true });
    expect(save).not.toHaveBeenCalled();
    expect(capture.textContent).toBe("Ctrl+S");
  });
});

describe("positive control", () => {
  it("Ctrl+S outside any capture box saves", async () => {
    await render();
    await pressIn(document.body, { key: "s", ctrlKey: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(1);
  });
});

// TWO boxes can be open at once: the Add Shortcut form stays open while a
// row's Edit is used. There used to be ONE capture slot ("a newer capture
// replaces an older one"): the row's Edit evicted the Add box, and the Add
// box's effect never registered again (its deps do not change), so from then
// on -- row edit still open, or cancelled -- Ctrl+S in the Add box SAVED the
// workbook again (review of BUG-0199).
describe("the Add Shortcut box and a row's Edit box, both open", () => {
  function addBox(): HTMLDivElement {
    const box = Array.from(container.querySelectorAll<HTMLDivElement>('div[tabindex="0"]')).find((d) =>
      (d.textContent ?? "").includes("press a key combination"),
    );
    if (!box) throw new Error("no Add Shortcut capture box");
    return box;
  }

  async function openAddForm(): Promise<void> {
    await act(async () => {
      button(container, "+ Add Shortcut").click();
    });
  }

  async function recordInAddBox(): Promise<HTMLDivElement> {
    const box = addBox();
    await act(async () => {
      box.focus();
    });
    await pressIn(box, { key: "s", ctrlKey: true });
    await act(async () => {
      await Promise.resolve();
    });
    return box;
  }

  it("row Edit opened and CANCELLED: Ctrl+S in the Add box is still recorded, not run", async () => {
    await render();
    await openAddForm();
    const rowBox = await editRow("Copy");
    await pressIn(rowBox, { key: "Escape" });
    const box = await recordInAddBox();
    expect(save, "Ctrl+S in the Add box SAVED the workbook").not.toHaveBeenCalled();
    expect(box.textContent).toBe("Ctrl+S");
  });

  it("row Edit STILL OPEN: Ctrl+S in the Add box is recorded there, not run, and not recorded in the row", async () => {
    await render();
    await openAddForm();
    const rowBox = await editRow("Copy");
    const box = await recordInAddBox();
    expect(save, "Ctrl+S in the Add box SAVED the workbook").not.toHaveBeenCalled();
    expect(box.textContent).toBe("Ctrl+S");
    expect(rowBox.textContent, "the Add box's key was recorded by the row's box").not.toContain("Ctrl+S");
  });

  it("and the row's box still records ITS keys while the Add form is open", async () => {
    await render();
    await openAddForm();
    const rowBox = await editRow("Copy");
    await act(async () => {
      rowBox.focus();
    });
    await pressIn(rowBox, { key: "p", ctrlKey: true });
    expect(extensionListener).not.toHaveBeenCalled();
    expect(rowBox.textContent).toBe("Ctrl+P");
    expect(addBox().textContent).not.toContain("Ctrl+P");
  });

  it("once BOTH close, the combination runs its command again", async () => {
    await render();
    await openAddForm();
    const rowBox = await editRow("Copy");
    await pressIn(rowBox, { key: "Escape" });
    await act(async () => {
      button(container, "Cancel").click();
    });
    await pressIn(document.body, { key: "s", ctrlKey: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(1);
  });
});
