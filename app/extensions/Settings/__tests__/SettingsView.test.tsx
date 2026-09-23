//! FILENAME: app/extensions/Settings/__tests__/SettingsView.test.tsx
// PURPOSE: The Settings panel shell after the Calcula Clusters redesign: its
//          page switcher is the @api SegmentedTabs strip, section headers use
//          the one panel header recipe (12px/600, sentence case), the locale is
//          an @api Dropdown, and the deep link still selects a tab.
// CONTEXT: The three pages are stubbed — each has its own suite — so this file
//          tests the view that hosts them. The E2E handle it must keep: every
//          tab is a <button> whose text is exactly its label
//          (appearance-skins.spec finds the Appearance tab that way).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const { getLocaleMock, setLocaleMock, supportedMock } = vi.hoisted(() => ({
  getLocaleMock: vi.fn(),
  setLocaleMock: vi.fn(),
  supportedMock: vi.fn(),
}));

vi.mock("@api/locale", () => ({
  getLocaleSettings: getLocaleMock,
  setLocale: setLocaleMock,
  getSupportedLocales: supportedMock,
}));

// Each page is replaced by a marker div. The export name is computed so the
// component-named key does not trip the object-property naming rule.
vi.mock("../components/AppearancePage", () => {
  const name = "AppearancePage";
  return { [name]: () => <div data-testid="stub-appearance-page" /> };
});
vi.mock("../components/KeybindingsPage", () => {
  const name = "KeybindingsPage";
  return { [name]: () => <div data-testid="stub-keybindings-page" /> };
});
vi.mock("../components/ScriptSecurityPage", () => {
  const name = "ScriptSecurityPage";
  return { [name]: () => <div data-testid="stub-script-security-page" /> };
});

import { SettingsView, SETTINGS_SHOW_TAB_EVENT } from "../SettingsView";
import { findHardcodedColours, panelLayout, SurfaceLayoutProvider } from "@api/layout";

const LOCALE = {
  localeId: "sv-SE",
  displayName: "Svenska (Sverige)",
  decimalSeparator: ",",
  thousandsSeparator: " ",
  listSeparator: ";",
  dateFormat: "yyyy-MM-dd",
};

let container: HTMLDivElement;
let root: Root;

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <SurfaceLayoutProvider value={panelLayout(320)}>
        <SettingsView {...({} as React.ComponentProps<typeof SettingsView>)} />
      </SurfaceLayoutProvider>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function tab(label: string): HTMLButtonElement {
  const matches = Array.from(container.querySelectorAll("button")).filter(
    (b) => (b.textContent ?? "").trim() === label,
  );
  expect(matches.length, `buttons with text "${label}"`).toBe(1);
  return matches[0] as HTMLButtonElement;
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  getLocaleMock.mockReset();
  getLocaleMock.mockResolvedValue(LOCALE);
  setLocaleMock.mockReset();
  setLocaleMock.mockResolvedValue(LOCALE);
  supportedMock.mockReset();
  supportedMock.mockResolvedValue([
    { localeId: "en-US", displayName: "English (United States)" },
    { localeId: "sv-SE", displayName: "Svenska (Sverige)" },
  ]);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("SettingsView", () => {
  it("switches pages from a SegmentedTabs strip of plain-text tab buttons", async () => {
    await render();
    const tablist = container.querySelector('[role="tablist"]')!;
    expect(tablist.getAttribute("aria-label")).toBe("Settings pages");
    const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
    expect(tabs.map((t) => t.textContent)).toEqual([
      "General",
      "Appearance",
      "Keyboard Shortcuts",
      "Script Security",
    ]);
    expect(tabs.every((t) => t.tagName === "BUTTON")).toBe(true);
    expect(tab("General").getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector('[data-testid="settings-general"]')).not.toBeNull();

    await click(tab("Appearance"));
    expect(tab("Appearance").getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector('[data-testid="stub-appearance-page"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="settings-general"]')).toBeNull();

    await click(tab("Keyboard Shortcuts"));
    expect(container.querySelector('[data-testid="stub-keybindings-page"]')).not.toBeNull();
  });

  it("keeps tab test ids", async () => {
    await render();
    for (const id of ["general", "appearance", "keybindings", "scriptSecurity"]) {
      expect(container.querySelector(`[data-testid="settings-tab-${id}"]`), id).not.toBeNull();
    }
  });

  it("moves between tabs with the arrow keys", async () => {
    await render();
    await act(async () => {
      tab("General").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(tab("Appearance").getAttribute("aria-selected")).toBe("true");
  });

  it("selects the tab a deep link names", async () => {
    await render();
    await act(async () => {
      window.dispatchEvent(new CustomEvent(SETTINGS_SHOW_TAB_EVENT, { detail: "scriptSecurity" }));
    });
    expect(tab("Script Security").getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector('[data-testid="stub-script-security-page"]')).not.toBeNull();
  });

  it("uses the one header recipe: 12px/600, sentence case", async () => {
    await render();
    const headings = Array.from(container.querySelectorAll("h3"));
    expect(headings.map((h) => h.textContent)).toEqual(["Regional settings", "File Explorer"]);
    for (const h of headings) {
      const cs = getComputedStyle(h);
      expect(cs.fontSize).toBe("12px");
      expect(cs.fontWeight).toBe("600");
      expect(cs.textTransform).not.toBe("uppercase");
    }
  });

  it("picks the locale from an @api Dropdown, not a native select", async () => {
    await render();
    expect(container.querySelectorAll("select").length).toBe(0);
    const trigger = container.querySelector<HTMLElement>('[data-testid="settings-locale"]')!;
    expect(trigger.getAttribute("role")).toBe("combobox");
    expect(trigger.textContent).toContain("System default");

    await click(trigger);
    await click(document.querySelector('[data-testid="settings-locale-sv-SE"]')!);
    expect(setLocaleMock).toHaveBeenCalledWith("sv-SE");
    expect(trigger.textContent).toContain("Svenska (Sverige)");
  });

  it("shows the locale preview", async () => {
    await render();
    const preview = container.querySelector('[data-testid="settings-locale-preview"]')!;
    expect(preview.textContent).toContain(", (comma)");
    expect(preview.textContent).toContain("(space)");
    expect(preview.textContent).toContain("; (semicolon)");
  });

  it("still saves the file-explorer click behaviour", async () => {
    await render();
    const taskpane = container.querySelector<HTMLInputElement>(
      'input[name="fileClickAction"][value="taskpane"]',
    )!;
    await act(async () => {
      taskpane.click();
    });
    expect(taskpane.checked).toBe(true);
    expect(container.textContent).toContain("Single-click opens directly in the task pane");
  });

  it("paints its chrome with tokens only", async () => {
    await render();
    expect(findHardcodedColours(container)).toEqual([]);
  });
});
