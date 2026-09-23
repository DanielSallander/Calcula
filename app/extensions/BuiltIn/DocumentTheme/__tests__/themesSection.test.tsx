//! FILENAME: app/extensions/BuiltIn/DocumentTheme/__tests__/themesSection.test.tsx
// PURPOSE: The Page Layout "Themes" cluster after the Calcula Clusters rebuild:
//          two CommandButton heroes, each opening a card gallery, painted with
//          tokens only.
// CONTEXT: Pins what the rebuild must not lose: the hero is the icon and label
//          (no hardcoded swatches, no unicode arrows), theme rows preview six
//          accent dots as colour DATA and the ACTIVE row previews the LIVE
//          document theme, and the font picker keeps its hover live-preview /
//          revert / commit contract.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  SurfaceLayoutProvider,
  bandLayout,
  panelLayout,
  findHardcodedColours,
  type SurfaceLayout,
} from "@api/layout";

type Theme = {
  name: string;
  colors: Record<string, string>;
  fonts: { heading: string; body: string };
};

function makeTheme(name: string, accent1: string, fonts = { heading: "Calibri Light", body: "Calibri" }): Theme {
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
    fonts,
  };
}

const OFFICE_BUILTIN = makeTheme("Office", "#4472c4");
const SLATE_BUILTIN = makeTheme("Slate", "#2f5597");
/** The live document theme: Office, but with an edited first accent. */
const LIVE_OFFICE = makeTheme("Office", "#123456");

const themeApi = vi.hoisted(() => ({
  getDocumentTheme: vi.fn(),
  setDocumentTheme: vi.fn(),
  listBuiltinThemes: vi.fn(),
}));
vi.mock("@api/theme", () => themeApi);

import { ThemesSection } from "../components/ThemesSection";
import {
  FONT_PAIRS,
  THEME_ACCENT_KEYS,
  fontPairTestId,
  themeRowTestId,
} from "../lib/themeChoices";

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function render(layout: SurfaceLayout): Promise<void> {
  act(() => {
    root.render(
      <SurfaceLayoutProvider value={layout}>
        <ThemesSection placement={layout.container === "band" ? "ribbon" : "sidebar"} />
      </SurfaceLayoutProvider>,
    );
  });
  await flush();
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function hover(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
  });
}

function leave(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
  });
}

function hero(testId: string): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (!el) throw new Error(`no hero ${testId}`);
  return el;
}

function openMenu(name: string): HTMLElement {
  const menu = document.body.querySelector<HTMLElement>(`[role="menu"][aria-label="${name}"]`);
  if (!menu) throw new Error(`menu ${name} is not open`);
  return menu;
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  themeApi.getDocumentTheme.mockReset().mockResolvedValue(LIVE_OFFICE);
  themeApi.listBuiltinThemes.mockReset().mockResolvedValue([OFFICE_BUILTIN, SLATE_BUILTIN]);
  themeApi.setDocumentTheme.mockReset().mockImplementation(async (theme: Theme) => {
    // Mirror the real API: a set announces the new theme.
    window.dispatchEvent(new CustomEvent("app:theme-changed", { detail: { theme } }));
    return { ok: true };
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("Page Layout Themes cluster", () => {
  it.each([
    ["band", bandLayout()],
    ["panel", panelLayout(300)],
  ] as const)("renders two token-painted heroes in the %s", async (_name, layout) => {
    await render(layout);
    const themes = hero("page-layout-themes");
    const fonts = hero("page-layout-fonts");

    // The hero's only text is its label: the icon and chevron are SVGs, the
    // old unicode arrows and hardcoded swatches are gone.
    expect(themes.textContent).toBe("Themes");
    expect(fonts.textContent).toBe("Fonts");
    expect(themes.querySelector("svg")).not.toBeNull();
    expect(fonts.querySelector("svg")).not.toBeNull();
    expect(themes.getAttribute("aria-haspopup")).toBe("dialog");
    expect(themes.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("[data-colour-data]")).toBeNull();

    expect(findHardcodedColours(container)).toEqual([]);
  });

  it("band heroes are 61px tall columns (one tall row fills the cluster)", async () => {
    await render(bandLayout());
    const themes = hero("page-layout-themes");
    const rule = Array.from(document.querySelectorAll("style"))
      .map((s) => s.textContent ?? "")
      .join("\n");
    const heroClass = Array.from(themes.classList).find((c) =>
      new RegExp(`\\.${c}[^{]*\\{[^}]*height:\\s*61px`).test(rule),
    );
    expect(heroClass).toBeDefined();
  });

  it("the theme gallery lists each theme with six accent dots as colour DATA and checks the live theme", async () => {
    await render(bandLayout());
    click(hero("page-layout-themes"));
    await flush();

    expect(hero("page-layout-themes").getAttribute("aria-expanded")).toBe("true");
    const menu = openMenu("Built-in Themes");
    const rows = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]'));
    expect(rows.map((r) => r.textContent)).toEqual(["Office", "Slate"]);

    const office = menu.querySelector<HTMLElement>(`[data-testid="${themeRowTestId("Office")}"]`)!;
    const slate = menu.querySelector<HTMLElement>(`[data-testid="${themeRowTestId("Slate")}"]`)!;
    expect(office.getAttribute("aria-checked")).toBe("true");
    expect(slate.getAttribute("aria-checked")).toBe("false");

    for (const row of [office, slate]) {
      const data = row.querySelector("[data-colour-data]");
      expect(data).not.toBeNull();
      expect(data!.children).toHaveLength(THEME_ACCENT_KEYS.length);
    }

    // The ACTIVE row previews the live document theme (edited accent1), the
    // others their own definitions.
    const officeFirstDot = office.querySelector<HTMLElement>("[data-colour-data] > span")!;
    const slateFirstDot = slate.querySelector<HTMLElement>("[data-colour-data] > span")!;
    expect(officeFirstDot.style.background).toBe("rgb(18, 52, 86)");
    expect(slateFirstDot.style.background).toBe("rgb(47, 85, 151)");

    // The card (portalled into body) paints chrome with tokens only; the dots
    // are exempt as colour data.
    expect(findHardcodedColours(document.body)).toEqual([]);
  });

  it("picking a theme applies it and closes the gallery", async () => {
    await render(panelLayout(300));
    click(hero("page-layout-themes"));
    await flush();
    click(openMenu("Built-in Themes").querySelector(`[data-testid="${themeRowTestId("Slate")}"]`)!);
    await flush();

    expect(themeApi.setDocumentTheme).toHaveBeenCalledWith(SLATE_BUILTIN);
    expect(document.body.querySelector('[role="menu"][aria-label="Built-in Themes"]')).toBeNull();
  });

  it("font rows preview each pair in its own faces", async () => {
    await render(bandLayout());
    click(hero("page-layout-fonts"));
    await flush();

    const menu = openMenu("Theme Fonts");
    const rows = menu.querySelectorAll('[role="menuitemradio"]');
    expect(rows).toHaveLength(FONT_PAIRS.length);

    const georgia = menu.querySelector<HTMLElement>(
      `[data-testid="${fontPairTestId({ heading: "Georgia", body: "Verdana" })}"]`,
    )!;
    const faces = Array.from(georgia.querySelectorAll<HTMLElement>("span[style]")).map(
      (s) => s.style.fontFamily,
    );
    expect(faces).toContain("Georgia");
    expect(faces).toContain("Verdana");

    // The live theme's pair is checked.
    const calibri = menu.querySelector<HTMLElement>(
      `[data-testid="${fontPairTestId({ heading: "Calibri Light", body: "Calibri" })}"]`,
    )!;
    expect(calibri.getAttribute("aria-checked")).toBe("true");
    expect(georgia.getAttribute("aria-checked")).toBe("false");

    expect(findHardcodedColours(document.body)).toEqual([]);
  });

  it("hovering a font pair previews it and leaving the list reverts to the snapshot", async () => {
    await render(bandLayout());
    click(hero("page-layout-fonts"));
    await flush();

    const menu = openMenu("Theme Fonts");
    const georgia = menu.querySelector<HTMLElement>(
      `[data-testid="${fontPairTestId({ heading: "Georgia", body: "Verdana" })}"]`,
    )!;
    hover(georgia);
    await flush();
    expect(themeApi.setDocumentTheme).toHaveBeenLastCalledWith({
      ...LIVE_OFFICE,
      fonts: { heading: "Georgia", body: "Verdana" },
    });

    leave(menu);
    await flush();
    expect(themeApi.setDocumentTheme).toHaveBeenLastCalledWith(LIVE_OFFICE);
  });

  it("clicking a font pair commits it; closing without a pick reverts", async () => {
    await render(panelLayout(300));

    // Commit.
    click(hero("page-layout-fonts"));
    await flush();
    const arial = openMenu("Theme Fonts").querySelector<HTMLElement>(
      `[data-testid="${fontPairTestId({ heading: "Arial", body: "Arial" })}"]`,
    )!;
    click(arial);
    await flush();
    const committed = { ...LIVE_OFFICE, fonts: { heading: "Arial", body: "Arial" } };
    expect(themeApi.setDocumentTheme).toHaveBeenLastCalledWith(committed);
    expect(document.body.querySelector('[role="menu"][aria-label="Theme Fonts"]')).toBeNull();

    // Open, preview, close by clicking the hero again: the preview is undone.
    themeApi.setDocumentTheme.mockClear();
    click(hero("page-layout-fonts"));
    await flush();
    hover(
      openMenu("Theme Fonts").querySelector(
        `[data-testid="${fontPairTestId({ heading: "Consolas", body: "Consolas" })}"]`,
      )!,
    );
    await flush();
    click(hero("page-layout-fonts"));
    await flush();
    expect(themeApi.setDocumentTheme).toHaveBeenLastCalledWith(committed);
  });
});
