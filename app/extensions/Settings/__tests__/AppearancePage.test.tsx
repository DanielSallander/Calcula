//! FILENAME: app/extensions/Settings/__tests__/AppearancePage.test.tsx
// PURPOSE: The Appearance page after the Calcula Clusters redesign: skin cards
//          that SHOW their skin (drawn from that skin's own tokens), the ribbon
//          group-label preference, the user accent colour with its contrast
//          warning, accessibility on @api Checkbox/Dropdown, the managed-policy
//          banner — and no hardcoded chrome colour anywhere on the page.
// CONTEXT: Runs against the REAL skin loader through @api/appearance (the page
//          is a thin view over it, so a mock would test the mock). The skins
//          are registered here because the built-in list is seeded by boot,
//          which a unit test does not run. Only the managed-policy reads are
//          doubled: they come from the Tauri side.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const { managedMock, refreshMock, paletteMock } = vi.hoisted(() => ({
  managedMock: vi.fn(),
  refreshMock: vi.fn(),
  paletteMock: vi.fn(),
}));

vi.mock("@api/appearancePolicy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@api/appearancePolicy")>();
  return {
    ...actual,
    getManagedAppearanceInfo: managedMock,
    refreshManagedAppearance: refreshMock,
  };
});

// The accent picker never asks for the document theme (an app accent is not a
// document colour); mocked so a regression that asks fails loudly.
vi.mock("@api/theme", () => ({ getThemeColorPalette: paletteMock }));

import { AppearancePage } from "../components/AppearancePage";
import {
  getActiveSkinId,
  getRibbonLabelMode,
  getUserTokenOverrides,
  registerSkin,
  setActiveSkin,
  setRibbonLabelMode,
  setUserTokenOverrides,
  type Skin,
} from "@api/appearance";
import { getUserAccessibility, setUserAccessibility } from "@api/appearancePolicy";
import {
  SurfaceLayoutProvider,
  bandLayout,
  findHardcodedColours,
  panelLayout,
  type SurfaceLayout,
} from "@api/layout";

// ============================================================================
// Fixtures
// ============================================================================

// Token names as constants: computed keys keep the repo naming rule happy.
const STATE_ACCENT = "--state-accent";
const ACCENT_PRIMARY = "--accent-primary";
const CLUSTER_BG = "--ribbon-cluster-bg";
const RADIUS_CLUSTER = "--radius-cluster";
const BAND_BG = "--ribbon-band-bg";
const RAIL_INDICATOR = "--activity-bar-indicator";

const LIGHT: Skin = { id: "calcula.light", name: "Light", base: "light", builtIn: true };
const DARK: Skin = { id: "calcula.dark", name: "Dark", base: "dark", builtIn: true };
/** A skin whose accent differs from the active one, so a preview that read
 *  the ACTIVE tokens instead of its own would be caught. */
const INDIGO: Skin = {
  id: "test.indigo",
  name: "Indigo",
  base: "light",
  tokens: {
    [STATE_ACCENT]: "#4f46e5",
    [CLUSTER_BG]: "#eef0f7",
    [RADIUS_CLUSTER]: "16px",
  },
};

let container: HTMLDivElement;
let root: Root;

function managedPolicy(overrides: Record<string, unknown> = {}) {
  return {
    managed: true,
    managedBy: "Acme IT",
    registryUrl: "https://skins.acme.example/registry",
    publisherFingerprint: "ab:cd:ef",
    trust: "verified",
    version: "1.2.0",
    policyError: "",
    ...overrides,
  };
}

async function render(layout?: SurfaceLayout): Promise<void> {
  const page = <AppearancePage />;
  await act(async () => {
    root.render(layout ? <SurfaceLayoutProvider value={layout}>{page}</SurfaceLayoutProvider> : page);
  });
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function byTestId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.querySelector<T>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`no element [data-testid="${id}"]`);
  return el;
}

function card(name: string): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(`button[title="${name}"]`);
  if (!el) throw new Error(`no skin card titled "${name}"`);
  return el;
}

async function pickAccent(colourName: string): Promise<void> {
  await click(byTestId("appearance-accent"));
  const popover = byTestId("appearance-accent-popover");
  const swatch = popover.querySelector(`[aria-label="${colourName}"]`);
  if (!swatch) throw new Error(`no swatch "${colourName}"`);
  await click(swatch);
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  managedMock.mockReset();
  managedMock.mockReturnValue(null);
  refreshMock.mockReset();
  refreshMock.mockResolvedValue(null);
  paletteMock.mockReset();
  paletteMock.mockResolvedValue([]);
  for (const skin of [LIGHT, DARK, INDIGO]) registerSkin(skin);
  setActiveSkin(LIGHT.id);
  setUserTokenOverrides(null);
  setRibbonLabelMode(null);
  setUserAccessibility({});
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  setUserTokenOverrides(null);
  setRibbonLabelMode(null);
  setUserAccessibility({});
  setActiveSkin(LIGHT.id);
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

// ============================================================================
// Token resolution inside a preview
// ============================================================================

describe("preview token resolution", () => {
  it("resolves a chained var() against the SAME skin's map", async () => {
    // The skin points the rail indicator at a token that itself points at
    // the accent: two hops, both resolved in THIS skin's map.
    registerSkin({
      id: "test.chain",
      name: "Chain",
      base: "light",
      tokens: {
        [STATE_ACCENT]: "#123456",
        [RAIL_INDICATOR]: "var(--focus-ring-color)",
      },
    });
    await render();
    const rail = byTestId("appearance-skin-preview-test.chain").querySelector<HTMLElement>(
      '[data-preview-part="rail"]',
    )!;
    const indicator = Array.from(rail.children).find(
      (el) => (el as HTMLElement).style.width === "2px",
    ) as HTMLElement;
    // --focus-ring-color is var(--state-accent) in the light baseline.
    expect(indicator.style.background).toBe("rgb(18, 52, 86)");
  });

  it("renders a skin whose tokens reference each other in a cycle", async () => {
    registerSkin({
      id: "test.cycle",
      name: "Cycle",
      base: "light",
      tokens: {
        [STATE_ACCENT]: "var(--activity-bar-indicator)",
        [RAIL_INDICATOR]: "var(--state-accent)",
      },
    });
    await render();
    expect(card("Cycle").tagName).toBe("BUTTON");
  });
});

// ============================================================================
// Skin cards
// ============================================================================

describe("skin cards", () => {
  it("renders one <button title={name}> card per registered skin, the active one pressed", async () => {
    await render();
    for (const name of ["Light", "Dark", "Indigo"]) {
      expect(card(name).tagName).toBe("BUTTON");
    }
    expect(card("Light").getAttribute("aria-pressed")).toBe("true");
    expect(card("Dark").getAttribute("aria-pressed")).toBe("false");
  });

  it("switches the active skin from a card", async () => {
    await render();
    await click(card("Dark"));
    expect(getActiveSkinId()).toBe(DARK.id);
    expect(card("Dark").getAttribute("aria-pressed")).toBe("true");
    expect(card("Light").getAttribute("aria-pressed")).toBe("false");
  });

  it("draws each preview from its own skin: rail, frame, band and two cluster cards", async () => {
    await render();
    const preview = byTestId(`appearance-skin-preview-${INDIGO.id}`);
    expect(preview.hasAttribute("data-colour-data")).toBe(true);
    const rail = preview.querySelector<HTMLElement>('[data-preview-part="rail"]')!;
    expect(rail.style.width).toBe("10px");
    expect(preview.querySelector('[data-preview-part="frame"]')).not.toBeNull();
    expect(preview.querySelector('[data-preview-part="band"]')).not.toBeNull();
    const clusters = preview.querySelectorAll<HTMLElement>('[data-preview-part="cluster"]');
    expect(clusters.length).toBe(2);
    // The skin's own cluster tint, not the active Light one.
    expect(clusters[0].style.background).toBe("rgb(238, 240, 247)");
    // --activity-bar-indicator is var(--state-accent): resolved against the
    // INDIGO map, so the rail shows indigo while Light is active.
    const indicator = Array.from(rail.children).find(
      (el) => (el as HTMLElement).style.width === "2px",
    ) as HTMLElement;
    expect(indicator.style.background).toBe("rgb(79, 70, 229)");
  });

  it("previews differ between light and dark skins", async () => {
    await render();
    const band = (id: string) =>
      byTestId(`appearance-skin-preview-${id}`).querySelector<HTMLElement>('[data-preview-part="band"]')!
        .style.background;
    expect(band(LIGHT.id)).not.toBe(band(DARK.id));
  });
});

// ============================================================================
// Customize
// ============================================================================

describe("ribbon group labels", () => {
  it("is a Show / Hide radio pill bound to the label preference", async () => {
    await render();
    const group = byTestId("appearance-ribbon-labels");
    expect(group.getAttribute("role")).toBe("radiogroup");
    expect(group.getAttribute("aria-label")).toBe("Ribbon group labels");
    expect(byTestId("appearance-ribbon-labels-show").getAttribute("aria-checked")).toBe("true");

    await click(byTestId("appearance-ribbon-labels-hide"));
    expect(getRibbonLabelMode()).toBe("hide");
    expect(document.documentElement.dataset.ribbonLabels).toBe("hide");
    expect(byTestId("appearance-ribbon-labels-hide").getAttribute("aria-checked")).toBe("true");

    await click(byTestId("appearance-ribbon-labels-show"));
    expect(getRibbonLabelMode()).toBe("show");
  });

  it("follows a change made elsewhere (the View menu)", async () => {
    await render();
    await act(async () => {
      setRibbonLabelMode("hide");
    });
    expect(byTestId("appearance-ribbon-labels-hide").getAttribute("aria-checked")).toBe("true");
  });
});

describe("accent colour", () => {
  it("shows the skin's accent until the user picks one", async () => {
    await render();
    expect(byTestId("appearance-accent-value").textContent).toBe("#047857 (skin)");
    expect(byTestId<HTMLButtonElement>("appearance-accent-reset").disabled).toBe(true);
  });

  it("writes BOTH accent tokens as user overrides, and Reset clears them", async () => {
    await render();
    await pickAccent("Blue");
    expect(getUserTokenOverrides()).toEqual({
      [ACCENT_PRIMARY]: "#0070c0",
      [STATE_ACCENT]: "#0070c0",
    });
    expect(byTestId("appearance-accent-value").textContent).toBe("#0070C0");
    // A good contrast pick shows no warning.
    expect(document.querySelector('[data-testid="appearance-accent-contrast"]')).toBeNull();

    expect(localStorage.getItem("calcula.appearance.userTokens")).not.toBeNull();
    await click(byTestId("appearance-accent-reset"));
    expect(getUserTokenOverrides()).toEqual({});
    // With nothing else overridden, Reset clears the preference outright (the
    // clean state is an ABSENT key — what the E2E residue guard expects).
    expect(localStorage.getItem("calcula.appearance.userTokens")).toBeNull();
    expect(byTestId("appearance-accent-value").textContent).toBe("#047857 (skin)");
  });

  it("keeps the user's other token overrides when setting and resetting the accent", async () => {
    setUserTokenOverrides({ [BAND_BG]: "#fafafa" });
    await render();
    await pickAccent("Blue");
    expect(getUserTokenOverrides()).toEqual({
      [BAND_BG]: "#fafafa",
      [ACCENT_PRIMARY]: "#0070c0",
      [STATE_ACCENT]: "#0070c0",
    });
    await click(byTestId("appearance-accent-reset"));
    expect(getUserTokenOverrides()).toEqual({ [BAND_BG]: "#fafafa" });
  });

  it("warns (tone warn) when the chosen accent is below 3:1 on white", async () => {
    await render();
    await pickAccent("Yellow");
    const chip = byTestId("appearance-accent-contrast");
    expect(chip.textContent).toContain("Low contrast");
    expect(chip.textContent).toContain(":1 on white");
    // The accent swatch shows the colour as DATA.
    expect(byTestId("appearance-accent").querySelector("[data-colour-data]")).not.toBeNull();
  });

  it("never asks for the document theme", async () => {
    await render();
    await click(byTestId("appearance-accent"));
    expect(paletteMock).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Accessibility
// ============================================================================

describe("accessibility", () => {
  it("has no native <select>: the pickers are @api Dropdowns", async () => {
    await render();
    expect(container.querySelectorAll("select").length).toBe(0);
    expect(byTestId("appearance-forced-base").getAttribute("role")).toBe("combobox");
    expect(byTestId("appearance-min-font-scale").getAttribute("role")).toBe("combobox");
  });

  it("toggles high contrast and reduced motion through @api Checkboxes", async () => {
    await render();
    const hc = byTestId<HTMLInputElement>("appearance-high-contrast");
    expect(hc.type).toBe("checkbox");
    expect(hc.closest("label")?.textContent).toContain("High contrast");
    await act(async () => {
      hc.click();
    });
    expect(getUserAccessibility().highContrast).toBe(true);

    await act(async () => {
      byTestId<HTMLInputElement>("appearance-reduced-motion").click();
    });
    expect(getUserAccessibility().reducedMotion).toBe(true);
  });

  it("sets the forced base and the minimum text size from the dropdowns", async () => {
    await render();
    await click(byTestId("appearance-forced-base"));
    await click(byTestId("appearance-forced-base-dark"));
    expect(getUserAccessibility().forcedBase).toBe("dark");
    expect(byTestId("appearance-forced-base").textContent).toContain("Always dark");

    await click(byTestId("appearance-forced-base"));
    await click(byTestId("appearance-forced-base-auto"));
    expect(getUserAccessibility().forcedBase).toBeNull();

    await click(byTestId("appearance-min-font-scale"));
    await click(byTestId("appearance-min-font-scale-1.25"));
    expect(getUserAccessibility().minFontScale).toBe(1.25);
  });
});

// ============================================================================
// Managed banner
// ============================================================================

describe("managed appearance banner", () => {
  it("shows the trust state as a toned chip and names a policy error", async () => {
    managedMock.mockReturnValue(
      managedPolicy({ trust: "notPinned", policyError: "policy.json has no publisherKey" }),
    );
    await render();
    const trust = byTestId("appearance-managed-trust");
    expect(trust.textContent).toBe("NOT trusted — unrecognised signer");
    expect(trust.getAttribute("title")).toContain("never agreed to trust");
    expect(byTestId("appearance-managed").querySelector('[role="alert"]')?.textContent).toBe(
      "policy.json has no publisherKey",
    );
  });

  it("an unknown trust state reads as unrecognised, not benign", async () => {
    managedMock.mockReturnValue(managedPolicy({ trust: "somethingNew" }));
    await render();
    expect(byTestId("appearance-managed-trust").textContent).toBe("unrecognised (somethingNew)");
  });

  it("checks for updates through the policy API", async () => {
    managedMock.mockReturnValue(managedPolicy());
    await render();
    const button = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Check for updates",
    )!;
    await click(button);
    expect(refreshMock).toHaveBeenCalled();
  });
});

// ============================================================================
// Tokens only
// ============================================================================

describe("no hardcoded chrome colours", () => {
  for (const [name, layout] of [
    ["band", bandLayout()],
    ["panel", panelLayout(320)],
  ] as const) {
    it(`paints only with tokens under ${name} geometry (previews and swatches are data)`, async () => {
      managedMock.mockReturnValue(managedPolicy({ trust: "unknown", policyError: "bad signature" }));
      setUserTokenOverrides({ [ACCENT_PRIMARY]: "#ffff00", [STATE_ACCENT]: "#ffff00" });
      await render(layout);
      // The warning chip and the banner are on screen for the scan.
      expect(byTestId("appearance-accent-contrast")).toBeTruthy();
      expect(byTestId("appearance-managed")).toBeTruthy();
      expect(findHardcodedColours(container)).toEqual([]);
    });
  }
});
