// The ribbon frame (RibbonContainer) and its panel context menu.
//
// Pins the DOM contracts the E2E/soak tooling reads (see the list in
// RibbonContainer.styles.ts): tab buttons whose ONLY text is the label, in
// the first <div> of [data-ribbon-content].parentElement; the active tab at
// font-weight 600; a badge as an aria-hidden SIBLING of its tab button; a
// trailing collapse control with no text; a 100px band padded 4px 8px that
// ends at display:none when minimized; the first <div> inside the band being
// the section strip. And that the context menu's items stay plain buttons.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../../../api/state", () => ({
  useGridState: () => ({ selection: null, editing: null }),
}));

import { RibbonContainer } from "../RibbonContainer";
import { PanelContextMenu } from "../PanelContextMenu";
import { ExtensionRegistry as ExtensionRegistryImpl } from "../../registries/ExtensionRegistry";
import { panelRegistry, initPanelRegistry } from "../../registries/panelRegistry";
import { usePanelPlacementStore } from "../../registries/usePanelPlacementStore";
import {
  registerExtensionRegistryService,
  type ExtensionRegistryService,
  type RibbonTabDefinition,
} from "../../../api/extensions";
import { emitAppEvent, AppEvents, onAppEvent } from "../../../api/events";
import { findHardcodedColours, RIBBON_BAND_HEIGHT } from "../../../api/layout";
import { getRibbonLabelMode, setRibbonLabelMode } from "../../../api/appearance";

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let container: HTMLDivElement;
let root: Root;

function StripContent(): React.ReactElement {
  return (
    <div data-testid="strip">
      <div data-testid="cell-a">A</div>
      <div data-testid="cell-b">B</div>
    </div>
  );
}

function tab(id: string, label: string, order: number, color?: string): RibbonTabDefinition {
  return {
    id,
    label,
    order,
    color,
    component: StripContent as unknown as RibbonTabDefinition["component"],
  };
}

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", NoopResizeObserver);
  ExtensionRegistryImpl.clear();
  panelRegistry.clear();
  usePanelPlacementStore.setState({ placements: {} });
  initPanelRegistry({
    activityBar: { registerView: () => {}, unregisterView: () => {} },
    extensionRegistry: {
      registerRibbonTab: (t) => ExtensionRegistryImpl.registerRibbonTab(t),
      unregisterRibbonTab: (id) => ExtensionRegistryImpl.unregisterRibbonTab(id),
    },
    getActivityBarStore: () => ({ openView: () => {}, close: () => {}, activeViewId: null }),
  });
  registerExtensionRegistryService({
    getRibbonTabs: () => ExtensionRegistryImpl.getRibbonTabs(),
    getRibbonGroupsForTab: (id: string) => ExtensionRegistryImpl.getRibbonGroupsForTab(id),
    getCommand: (id: string) => ExtensionRegistryImpl.getCommand(id),
    onRegistryChange: (cb: () => void) => ExtensionRegistryImpl.onRegistryChange(cb),
  } as unknown as ExtensionRegistryService);
  ExtensionRegistryImpl.registerRibbonTab(tab("home", "Home", 1));
  ExtensionRegistryImpl.registerRibbonTab(tab("anim", "Animation", 5));
  ExtensionRegistryImpl.registerRibbonTab(
    tab("chart", "Chart Design", 90, "var(--tab-accent-chart, #1d5fd0)"),
  );
  setRibbonLabelMode("show");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  panelRegistry.setBadge("anim", "");
  setRibbonLabelMode("show");
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function renderRibbon(): void {
  act(() => {
    root.render(<RibbonContainer />);
  });
}

function band(): HTMLElement {
  const el = container.querySelector<HTMLElement>("[data-ribbon-content]");
  if (!el) throw new Error("no band");
  return el;
}

/** Exactly how e2e/invariants/stateSnapshot.ts finds the strip. */
function strip(): HTMLElement {
  const el = band().parentElement?.querySelector("div");
  if (!el) throw new Error("no strip");
  return el as HTMLElement;
}

function tabButton(label: string): HTMLButtonElement | undefined {
  return Array.from(strip().querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  );
}

describe("RibbonContainer tab strip", () => {
  it("renders every tab as a <button> whose only text is its label, first in the strip", () => {
    renderRibbon();
    for (const label of ["Home", "Animation", "Chart Design"]) {
      expect(tabButton(label), label).toBeDefined();
    }
    // The first <button> of the strip is a tab (the elementFromPoint probe).
    expect(strip().querySelector("button")?.textContent).toBe("Home");
  });

  it("marks the active tab 600 and switches on click", () => {
    renderRibbon();
    expect(getComputedStyle(tabButton("Home")!).fontWeight).toBe("600");
    expect(getComputedStyle(tabButton("Animation")!).fontWeight).toBe("400");
    act(() => tabButton("Animation")!.click());
    expect(getComputedStyle(tabButton("Animation")!).fontWeight).toBe("600");
    expect(getComputedStyle(tabButton("Home")!).fontWeight).toBe("400");
  });

  it("draws a badge as an aria-hidden SIBLING, so the button's text stays the label", () => {
    panelRegistry.setBadge("anim", "2");
    renderRibbon();
    const button = tabButton("Animation");
    expect(button, "a badged tab still matches by exact label").toBeDefined();
    expect(button!.textContent).toBe("Animation");
    const badge = button!.parentElement!.querySelector("[data-tab-badge='anim']");
    expect(badge).not.toBeNull();
    expect(badge!.getAttribute("aria-hidden")).toBe("true");
    expect(badge!.textContent).toBe("2");
    expect(button!.contains(badge)).toBe(false);
  });

  it("gives contextual tabs their accent as the label colour (no colour-mix fade)", () => {
    renderRibbon();
    const chart = tabButton("Chart Design")!;
    const rules = Array.from(document.querySelectorAll("style"))
      .map((s) => s.textContent ?? "")
      .join("\n");
    const cls = (chart.getAttribute("class") ?? "").split(/\s+/);
    const own = rules
      .split("}")
      .filter((r) => cls.some((c) => c && r.includes(`.${c}`)))
      .join("}");
    expect(own).toContain("var(--tab-accent-chart, #1d5fd0)");
    expect(own).not.toContain("color-mix");
  });

  it("ends the strip with a text-less collapse control that toggles the ribbon", () => {
    renderRibbon();
    const toggle = strip().querySelector<HTMLButtonElement>("[data-testid='ribbon-collapse-toggle']");
    expect(toggle).not.toBeNull();
    expect(toggle!.textContent).toBe("");
    expect(toggle!.getAttribute("aria-label")).toBe("Collapse ribbon");
    // It is the LAST button in the strip, after every tab.
    const buttons = Array.from(strip().querySelectorAll("button"));
    expect(buttons[buttons.length - 1]).toBe(toggle);

    const seen = vi.fn();
    const off = onAppEvent(AppEvents.RIBBON_TOGGLE_MINIMIZE, seen);
    act(() => toggle!.click());
    off();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(toggle!.getAttribute("aria-label")).toBe("Expand ribbon");
  });
});

describe("RibbonContainer band", () => {
  it("is RIBBON_BAND_HEIGHT tall with 4px 8px padding on the band token", () => {
    renderRibbon();
    expect(band().style.height).toBe(`${RIBBON_BAND_HEIGHT}px`);
    expect(band().style.padding).toBe("4px 8px");
    expect(band().getAttribute("style")).toContain("--ribbon-band-bg");
  });

  it("keeps the section strip as the FIRST <div> inside the band (D6 contract)", () => {
    renderRibbon();
    expect(band().querySelector("div")?.getAttribute("data-testid")).toBe("strip");
  });

  it("minimizes by animating to 0 and ENDING at display:none; restores to flex", () => {
    renderRibbon();
    expect(getComputedStyle(band()).display).toBe("flex");
    expect(band().hasAttribute("data-ribbon-minimized")).toBe(false);
    act(() => emitAppEvent(AppEvents.RIBBON_TOGGLE_MINIMIZE));
    // Mid-collapse: still laid out, height already 0 (the transition runs),
    // and the state marker is already set.
    expect(band().style.height).toBe("0px");
    expect(getComputedStyle(band()).display).toBe("flex");
    expect(band().hasAttribute("data-ribbon-minimized")).toBe(true);
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(getComputedStyle(band()).display).toBe("none");
    act(() => emitAppEvent(AppEvents.RIBBON_TOGGLE_MINIMIZE));
    expect(getComputedStyle(band()).display).toBe("flex");
    expect(band().style.height).toBe(`${RIBBON_BAND_HEIGHT}px`);
    expect(band().hasAttribute("data-ribbon-minimized")).toBe(false);
  });

  it("a tab click while minimized shows the band as an overlay without re-docking it", () => {
    renderRibbon();
    act(() => emitAppEvent(AppEvents.RIBBON_TOGGLE_MINIMIZE));
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(getComputedStyle(band()).display).toBe("none");
    act(() => tabButton("Animation")!.click());
    expect(getComputedStyle(band()).display).toBe("flex");
    expect(band().style.position).toBe("absolute");
    expect(band().style.height).toBe(`${RIBBON_BAND_HEIGHT}px`);
    // A toggle from the overlay lands docked, never in a stale overlay.
    act(() => emitAppEvent(AppEvents.RIBBON_TOGGLE_MINIMIZE));
    expect(band().style.position).toBe("relative");
    act(() => emitAppEvent(AppEvents.RIBBON_TOGGLE_MINIMIZE));
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(getComputedStyle(band()).display).toBe("none");
  });

  it("switching tabs re-keys the band content (the fade-in wrapper is a <section>)", () => {
    renderRibbon();
    const before = band().querySelector("section");
    expect(before).not.toBeNull();
    act(() => tabButton("Animation")!.click());
    const after = band().querySelector("section");
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  });

  it("shows one empty-state note when no tab is registered", () => {
    ExtensionRegistryImpl.clear();
    renderRibbon();
    expect(band().textContent).toMatch(/No ribbon tabs are registered/);
    expect(strip().querySelectorAll("button")).toHaveLength(1); // only the collapse control
  });

  it("paints the frame with tokens only", () => {
    panelRegistry.setBadge("anim", "3");
    renderRibbon();
    expect(findHardcodedColours(container)).toEqual([]);
  });
});

describe("PanelContextMenu", () => {
  function renderMenu(props: Partial<React.ComponentProps<typeof PanelContextMenu>> = {}) {
    const onMove = vi.fn();
    const onClose = vi.fn();
    act(() => {
      root.render(
        <PanelContextMenu
          position={{ x: 40, y: 50 }}
          currentPlacement="ribbon"
          panelId="anim"
          panelTitle="Animation"
          onMove={onMove}
          onClose={onClose}
          {...props}
        />,
      );
    });
    return { onMove, onClose };
  }

  function menuButton(name: RegExp): HTMLButtonElement | undefined {
    return Array.from(document.body.querySelectorAll<HTMLButtonElement>("[data-panel-context-menu] > button")).find(
      (b) => name.test(b.textContent ?? ""),
    );
  }

  it("keeps plain <button> items with the exact labels the E2E drives", () => {
    renderMenu();
    const move = menuButton(/Move to Sidebar/);
    const edit = menuButton(/Edit Script\.\.\./);
    expect(move).toBeDefined();
    expect(edit).toBeDefined();
    expect(move!.tagName).toBe("BUTTON");
    expect(move!.hasAttribute("role")).toBe(false);
    expect(edit!.hasAttribute("role")).toBe(false);
  });

  it("offers Move to Ribbon from the sidebar, with the move hint", () => {
    renderMenu({ currentPlacement: "sidebar", moveHint: "Works best in the sidebar" });
    const move = menuButton(/Move to Ribbon/);
    expect(move).toBeDefined();
    expect(move!.textContent).toContain("Works best in the sidebar");
    // The group-label preference is a ribbon affordance.
    expect(menuButton(/group labels/)).toBeUndefined();
  });

  it("hides the move item for an immovable panel", () => {
    renderMenu({ canMoveToTarget: false });
    expect(menuButton(/Move to/)).toBeUndefined();
    expect(menuButton(/Edit Script/)).toBeDefined();
  });

  it("moves and closes", () => {
    const { onMove, onClose } = renderMenu();
    act(() => menuButton(/Move to Sidebar/)!.click());
    expect(onMove).toHaveBeenCalledWith("sidebar");
    expect(onClose).toHaveBeenCalled();
  });

  it("emits the edit-script event for the panel", () => {
    const seen = vi.fn();
    const off = onAppEvent("scriptable-objects:edit-script", seen);
    renderMenu();
    act(() => menuButton(/Edit Script/)!.click());
    off();
    expect(seen).toHaveBeenCalledWith(
      expect.objectContaining({ objectType: "panel", instanceId: "anim", objectName: "Animation" }),
    );
  });

  it("toggles the group-label preference", () => {
    renderMenu();
    expect(menuButton(/Hide group labels/)).toBeDefined();
    act(() => menuButton(/Hide group labels/)!.click());
    expect(getRibbonLabelMode()).toBe("hide");
    act(() => root.render(<></>));
    renderMenu();
    expect(menuButton(/Show group labels/)).toBeDefined();
  });

  it("closes on Escape", () => {
    const { onClose } = renderMenu();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("paints with tokens only", () => {
    renderMenu({ moveHint: "Works best in the sidebar" });
    expect(findHardcodedColours(document.body)).toEqual([]);
  });
});

describe("a tab registered with activateOnRegister (the Canvas tab)", () => {
  function isActive(label: string): boolean {
    const b = tabButton(label);
    return !!b && getComputedStyle(b).fontWeight === "600";
  }

  function canvasTab(): RibbonTabDefinition {
    return {
      ...tab("canvas", "Canvas", 50, "var(--tab-accent-canvas, #b0245f)"),
      activateOnRegister: true,
    };
  }

  it("is selected when it appears, and removing it returns to the tab the user HAD", () => {
    renderRibbon();
    act(() => tabButton("Animation")!.click());
    expect(isActive("Animation")).toBe(true);

    act(() => ExtensionRegistryImpl.registerRibbonTab(canvasTab()));
    expect(isActive("Canvas")).toBe(true);

    act(() => ExtensionRegistryImpl.unregisterRibbonTab("canvas"));
    // Not Home (the old fallback): the tab that was selected before the canvas.
    expect(isActive("Animation")).toBe(true);
  });

  it("a choice the user made while it was up is kept when it goes away", () => {
    renderRibbon();
    act(() => ExtensionRegistryImpl.registerRibbonTab(canvasTab()));
    expect(isActive("Canvas")).toBe(true);
    act(() => tabButton("Chart Design")!.click());
    act(() => ExtensionRegistryImpl.unregisterRibbonTab("canvas"));
    expect(isActive("Chart Design")).toBe(true);
  });

  it("an unrelated registry change does not re-select it", () => {
    renderRibbon();
    act(() => ExtensionRegistryImpl.registerRibbonTab(canvasTab()));
    act(() => tabButton("Home")!.click());
    act(() => ExtensionRegistryImpl.registerRibbonTab(tab("extra", "Extra", 60)));
    expect(isActive("Home")).toBe(true);
  });

  it("POSITIVE CONTROL: an ordinary contextual tab still never steals the selection", () => {
    renderRibbon();
    act(() => tabButton("Animation")!.click());
    act(() =>
      ExtensionRegistryImpl.registerRibbonTab(tab("pivot", "Pivot Table", 80, "var(--tab-accent-pivot, #1a7a43)")),
    );
    expect(isActive("Animation")).toBe(true);
  });
});
