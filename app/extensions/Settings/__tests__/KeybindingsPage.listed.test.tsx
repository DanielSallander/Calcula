//! FILENAME: app/extensions/Settings/__tests__/KeybindingsPage.listed.test.tsx
// PURPOSE: The keyboard settings list shows the shortcuts a user looks up and
//          remaps, and not the REFUSAL bindings a feature registers to say
//          "not now" over somebody else's key (KeyBinding.listed === false).
// CONTEXT: Fix round 4, F1. Round 3 registered FloatingRange's refused grid
//          keys (FR_REFUSED_GRID_KEYS) as ordinary KeyBindings, and the page
//          grew about forty "X (Floating Range)" rows -- each with an Edit
//          button that would move the refusal OFF the key it refuses. Runs the
//          REAL page over the REAL registry (the page is a thin view over it,
//          so a mocked registry would test the mock), and the REAL
//          FloatingRange installer for the case that prompted the flag.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { KeybindingsPage } from "../components/KeybindingsPage";
import { initKeybindings, registerKeybinding, isListedKeybinding } from "@api/keybindings";
import { panelLayout, SurfaceLayoutProvider } from "@api/layout";
import {
  FR_REFUSED_GRID_KEYS,
  installFrKeyRouting,
} from "../../FloatingRange/lib/frKeyRouting";

initKeybindings();

let container: HTMLDivElement;
let root: Root;
const cleanups: (() => void)[] = [];

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  while (cleanups.length > 0) cleanups.pop()!();
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

/** The label of every binding row on the page (the first span of the first cell). */
function rowLabels(): string[] {
  return Array.from(container.querySelectorAll("tbody tr"))
    .map((tr) => tr.querySelector("td span")?.textContent ?? "")
    .filter((t) => t !== "");
}

/** The command id shown under each row's label. */
function rowCommandIds(): string[] {
  return Array.from(container.querySelectorAll("tbody tr"))
    .map((tr) => tr.querySelectorAll("td:first-child span")[1]?.textContent ?? "")
    .filter((t) => t !== "");
}

function register(
  id: string,
  combo: string,
  label: string,
  listed?: boolean,
  context?: "always" | "editing" | "not-editing",
): void {
  cleanups.push(
    registerKeybinding({
      id,
      combo,
      commandId: `${id}.cmd`,
      label,
      category: "Listed Test",
      source: "extension",
      extensionId: "test.listed",
      ...(listed === undefined ? {} : { listed }),
      ...(context === undefined ? {} : { context }),
    }),
  );
}

describe("KeybindingsPage: KeyBinding.listed", () => {
  it("omits a binding that declares listed: false and still lists an ordinary one beside it", async () => {
    register("test.listed.ordinary", "Ctrl+Shift+Q", "Ordinary Thing");
    register("test.listed.explicit", "Ctrl+Alt+Q", "Explicitly Listed Thing", true);
    register("test.listed.refusal", "Ctrl+Alt+Shift+Q", "Refused Thing (Test)", false);
    await render();
    const labels = rowLabels();
    expect(labels).toContain("Ordinary Thing");
    expect(labels).toContain("Explicitly Listed Thing");
    expect(labels).not.toContain("Refused Thing (Test)");
    // The built-ins are still there: the filter hides one kind of row, not the list.
    expect(labels).toContain("Copy");
    expect(labels).toContain("Format Painter");
  });

  it("the rule is one predicate: absent and true are listed, only false is not", () => {
    const base = { id: "x", combo: "Ctrl+Q", commandId: "x", label: "x", category: "x", source: "extension" as const };
    expect(isListedKeybinding(base)).toBe(true);
    expect(isListedKeybinding({ ...base, listed: true })).toBe(true);
    expect(isListedKeybinding({ ...base, listed: false })).toBe(false);
  });

  it("FloatingRange's refusal bindings are off the list; its real Delete/Backspace and every built-in stay on it", async () => {
    cleanups.push(installFrKeyRouting({ extensionId: "calcula.floating-range", deleteSelection: vi.fn() }));
    await render();
    const labels = rowLabels();
    const commandIds = rowCommandIds();
    expect(labels.filter((l) => l.endsWith("(Floating Range)"))).toEqual([]);
    expect(commandIds.filter((c) => c.startsWith("ext.floatingRange.refuse."))).toEqual([]);
    // The range's own Delete/Backspace is a real shortcut, not a refusal.
    expect(labels.filter((l) => l === "Clear Floating Range Cells")).toHaveLength(2);
    // The keys the range refuses are still listed under their real owners.
    for (const label of ["Copy", "Paste", "Fill Down", "Insert Table", "Toggle AutoFilter", "Insert Hyperlink"]) {
      expect(labels, label).toContain(label);
    }
    // ...and the refusals are registered (dispatch is untouched), just not shown.
    expect(FR_REFUSED_GRID_KEYS.length).toBeGreaterThan(30);
  });

  it("a conflict warning names only listed bindings", async () => {
    // Ctrl+Alt+Shift+W is held by one listed and one unlisted binding. Both
    // are "editing"-context so the window-capture dispatcher does not RUN one
    // of them when the capture box hears the key (conflicts ignore context).
    register("test.listed.editme", "Ctrl+Shift+Y", "Edit Me");
    register("test.listed.holder", "Ctrl+Alt+Shift+W", "Visible Holder", undefined, "editing");
    register("test.listed.hiddenHolder", "Ctrl+Alt+Shift+W", "Hidden Holder (Test)", false, "editing");
    await render();
    const row = Array.from(container.querySelectorAll("tbody tr")).find(
      (tr) => tr.querySelector("td span")?.textContent === "Edit Me",
    )!;
    const edit = Array.from(row.querySelectorAll("button")).find((b) => b.textContent === "Edit")!;
    await act(async () => {
      edit.click();
    });
    const capture = container.querySelector<HTMLDivElement>('div[tabindex="0"]')!;
    await act(async () => {
      capture.dispatchEvent(
        new KeyboardEvent("keydown", { key: "w", ctrlKey: true, altKey: true, shiftKey: true, bubbles: true, cancelable: true }),
      );
    });
    const warning = Array.from(container.querySelectorAll("div")).find((d) =>
      (d.textContent ?? "").startsWith("Conflict with:"),
    );
    expect(warning?.textContent).toBe("Conflict with: Visible Holder");
  });
});
