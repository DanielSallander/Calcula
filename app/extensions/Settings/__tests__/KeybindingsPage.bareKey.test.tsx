//! FILENAME: app/extensions/Settings/__tests__/KeybindingsPage.bareKey.test.tsx
// PURPOSE: Settings > Keyboard shortcuts REFUSES a shortcut on a bare printable
//          key -- Space, Enter, a letter, a digit, with no modifier -- and says
//          why in one sentence, in both capture boxes (a row's Edit and the Add
//          Shortcut form). Nothing is stored.
// CONTEXT: Owner call 23 (2026-10-02). A user's binding on a key the grid owns
//          (Ctrl+Space) wins, with the conflict named -- that stays. A binding
//          on a BARE key would also take that key from every text field and
//          from the first keystroke of every cell entry, so the page shows the
//          refusal where the conflict warning goes and offers no Accept / Add.
//          Runs the REAL page over the REAL registry (@api/keybindings
//          bareKeyShortcutRefusal is the rule; the page only shows it).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { KeybindingsPage } from "../components/KeybindingsPage";
import {
  bareKeyShortcutRefusal,
  getAllKeybindings,
  getEffectiveCombo,
  hasUserOverride,
  initKeybindings,
  removeCustomKeybinding,
  resetAllKeybindings,
} from "@api/keybindings";
import { CommandRegistry } from "@api/commands";
import { panelLayout, SurfaceLayoutProvider } from "@api/layout";

initKeybindings();

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  resetAllKeybindings();
  CommandRegistry.register("test.bareKey.mine", () => {});
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  CommandRegistry.unregister("test.bareKey.mine");
  for (const b of getAllKeybindings()) if (b.source === "user") removeCustomKeybinding(b.id);
  resetAllKeybindings();
  localStorage.clear();
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

function buttonIn(scope: ParentNode, text: string): HTMLButtonElement | null {
  return (Array.from(scope.querySelectorAll("button")).find((el) => el.textContent === text) as HTMLButtonElement) ?? null;
}

async function pressIn(el: HTMLElement, init: KeyboardEventInit): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
}

async function editRow(label: string): Promise<HTMLDivElement> {
  await act(async () => {
    buttonIn(rowOf(label), "Edit")!.click();
  });
  const capture = rowOf(label).querySelector<HTMLDivElement>('div[tabindex="0"]');
  if (!capture) throw new Error("no capture box");
  return capture;
}

/** The refusal the page shows, or null. */
function refusalIn(scope: ParentNode): string | null {
  return scope.querySelector("[data-shortcut-refusal]")?.textContent ?? null;
}

describe("a row's Edit: a bare key is refused with the sentence, and cannot be accepted", () => {
  it.each([
    ["Space", { key: " ", code: "Space" }],
    ["Enter", { key: "Enter", code: "Enter" }],
    ["A", { key: "a", code: "KeyA" }],
    ["7", { key: "7", code: "Digit7" }],
  ] as const)("%s: the box shows it, the sentence is shown, there is no Accept", async (shown, init) => {
    await render();
    const capture = await editRow("Copy");
    await pressIn(capture, init);
    expect(capture.textContent).toBe(shown);
    expect(refusalIn(rowOf("Copy")), `${shown} was not refused`).toBe(bareKeyShortcutRefusal(shown));
    expect(buttonIn(rowOf("Copy"), "Accept"), `${shown} could still be accepted`).toBeNull();
    expect(hasUserOverride("core.copy")).toBe(false);
  });

  it("the box keeps recording: Ctrl+Space after Space clears the refusal and can be accepted", async () => {
    await render();
    const capture = await editRow("Copy");
    await pressIn(capture, { key: " ", code: "Space" });
    expect(refusalIn(rowOf("Copy"))).not.toBeNull();
    await pressIn(capture, { key: " ", code: "Space", ctrlKey: true });
    expect(capture.textContent).toBe("Ctrl+Space");
    expect(refusalIn(rowOf("Copy")), "the refusal outlived the bare key").toBeNull();
    // Ctrl+Space is a key the grid owns: named as the conflict, never refused.
    expect(rowOf("Copy").textContent).toContain("Select Entire Column");
    await act(async () => {
      buttonIn(rowOf("Copy"), "Accept")!.click();
    });
    expect(getEffectiveCombo("core.copy")).toBe("Ctrl+Space");
  });
});

describe("the Add Shortcut form: a bare key is refused with the sentence, and Add stays off", () => {
  async function openAddForm(): Promise<HTMLDivElement> {
    await act(async () => {
      buttonIn(container, "+ Add Shortcut")!.click();
    });
    const select = container.querySelector("select")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setter.call(select, "test.bareKey.mine");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const box = Array.from(container.querySelectorAll<HTMLDivElement>('div[tabindex="0"]')).find((d) =>
      (d.textContent ?? "").includes("press a key combination"),
    );
    if (!box) throw new Error("no Add Shortcut capture box");
    await act(async () => {
      box.focus();
    });
    return box;
  }

  it("Space: the sentence is shown, Add is disabled, and clicking it adds nothing", async () => {
    await render();
    const box = await openAddForm();
    await pressIn(box, { key: " ", code: "Space" });
    expect(box.textContent).toBe("Space");
    expect(refusalIn(container)).toBe(bareKeyShortcutRefusal("Space"));
    const add = buttonIn(container, "Add")!;
    expect(add.disabled, "Add is offered for a bare Space").toBe(true);
    const before = getAllKeybindings().filter((b) => b.source === "user").length;
    await act(async () => {
      add.click();
    });
    expect(getAllKeybindings().filter((b) => b.source === "user").length).toBe(before);
  });

  it("positive control: Ctrl+Space with a command chosen is added", async () => {
    await render();
    const box = await openAddForm();
    await pressIn(box, { key: " ", code: "Space", ctrlKey: true });
    expect(refusalIn(container)).toBeNull();
    const add = buttonIn(container, "Add")!;
    expect(add.disabled).toBe(false);
    await act(async () => {
      add.click();
    });
    expect(getAllKeybindings().some((b) => b.source === "user" && b.commandId === "test.bareKey.mine")).toBe(true);
  });
});
