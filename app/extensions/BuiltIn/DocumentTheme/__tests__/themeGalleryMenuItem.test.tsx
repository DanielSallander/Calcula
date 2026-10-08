//! FILENAME: app/extensions/BuiltIn/DocumentTheme/__tests__/themeGalleryMenuItem.test.tsx
// PURPOSE: Canvas contract §4.5 -- the document theme gallery is reachable from
//          another tab WITHOUT importing this extension: Document Theme
//          registers it with the theme-gallery seam (@api/themeGallery), and
//          any ribbon tab hosts what is registered there. Pins: the hosted
//          gallery is the SAME gallery (the same rows, test ids and live check
//          as Page Layout > Themes), a pick applies the theme and closes, and
//          deactivation takes it back so a host greys.
// CONTEXT: Review finding (2026-10-08): the gallery used to be registered as
//          a Format > Themes MENU-BAR item, so the seam added a non-Excel
//          entry to the Format menu as a side effect. It is no menu item now,
//          and this file pins that too.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

type Theme = { name: string; colors: Record<string, string>; fonts: { heading: string; body: string } };

function makeTheme(name: string, accent1: string): Theme {
  return {
    name,
    colors: {
      dark1: "#000000",
      light1: "#ffffff",
      dark2: "#44546a",
      light2: "#e7e6e6",
      accent1,
      accent2: "#ed7d31",
      accent3: "#a5a5a5",
      accent4: "#ffc000",
      accent5: "#5b9bd5",
      accent6: "#70ad47",
      hyperlink: "#0563c1",
      followedHyperlink: "#954f72",
    },
    fonts: { heading: "Calibri Light", body: "Calibri" },
  };
}

const OFFICE = makeTheme("Office", "#4472c4");
const SLATE = makeTheme("Slate", "#2f5597");

const themeApi = vi.hoisted(() => ({
  getDocumentTheme: vi.fn(),
  setDocumentTheme: vi.fn(),
  listBuiltinThemes: vi.fn(),
}));
vi.mock("@api/theme", () => themeApi);
vi.mock("@api/styleInterceptors", () => ({ markSheetDirty: vi.fn() }));

import { registerMenu, unregisterMenu, getMenus } from "@api/ui";
import { getThemeGallery } from "@api/themeGallery";
import extension from "../index";
import { themeRowTestId } from "../lib/themeChoices";

let container: HTMLDivElement;
let root: Root;
let closed = 0;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** What a host draws: the registered gallery's body, with its close. */
async function renderHosted(): Promise<void> {
  const gallery = getThemeGallery();
  expect(gallery, "no theme gallery is registered").not.toBeNull();
  act(() => {
    root.render(<div data-testid="host">{gallery!.render(() => (closed += 1))}</div>);
  });
  await flush();
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  closed = 0;
  themeApi.getDocumentTheme.mockReset().mockResolvedValue(OFFICE);
  themeApi.listBuiltinThemes.mockReset().mockResolvedValue([OFFICE, SLATE]);
  themeApi.setDocumentTheme.mockReset().mockImplementation(async (theme: Theme) => {
    window.dispatchEvent(new CustomEvent("app:theme-changed", { detail: { theme } }));
    return { ok: true };
  });
  // The Format menu is StandardMenus'; a stand-in, to prove nothing lands in it.
  registerMenu({ id: "format", label: "Format", order: 35, items: [] });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  extension.deactivate?.();
  unregisterMenu("format");
  document.body.innerHTML = "";
});

describe("the theme gallery on the theme-gallery seam", () => {
  // SABOTAGE: drop the registerThemeGallery call from activate() -> nothing is
  // registered and every host greys.
  it("is registered at activation, headed like the Page Layout card", () => {
    extension.activate({} as never);
    const gallery = getThemeGallery();
    expect(gallery).not.toBeNull();
    expect(gallery!.heading).toBe("Built-in Themes");
    expect(typeof gallery!.render).toBe("function");
  });

  it("adds NO Format menu item (the seam is not a menu-bar entry)", () => {
    extension.activate({} as never);
    const format = getMenus().find((m) => m.id === "format")!;
    expect(format.items.map((i) => i.id)).toEqual([]);
  });

  it("hosted elsewhere, draws the SAME gallery rows and applies a pick", async () => {
    extension.activate({} as never);
    await renderHosted();

    const office = document.body.querySelector<HTMLElement>(`[data-testid="${themeRowTestId("Office")}"]`);
    const slate = document.body.querySelector<HTMLElement>(`[data-testid="${themeRowTestId("Slate")}"]`);
    expect(office, "the Office row is missing").not.toBeNull();
    expect(slate, "the Slate row is missing").not.toBeNull();
    expect(office!.getAttribute("aria-checked")).toBe("true");
    expect(slate!.getAttribute("aria-checked")).toBe("false");

    click(slate!);
    await flush();
    expect(themeApi.setDocumentTheme).toHaveBeenCalledWith(SLATE);
    // The host was told to close with the pick.
    expect(closed).toBe(1);
  });

  it("is taken back at deactivation, so a host greys instead of opening nothing", () => {
    extension.activate({} as never);
    extension.deactivate?.();
    expect(getThemeGallery()).toBeNull();
  });
});
