//! FILENAME: app/src/shell/ActivityBar/__tests__/ActivityBar.test.tsx
// PURPOSE: The activity rail after the Calcula Clusters redesign — every
//          behaviour it had (names, toggling, events, badges, the right-click
//          move menu) on the new token chrome, and no hardcoded colour anywhere
//          in what it renders.
// CONTEXT: The rail was inline style objects on a literal #333333 ground with
//          white icons and a 2px white bar; it now paints from the
//          --activity-bar-* tokens (ActivityBar.styles.ts). The accessible name
//          (aria-label = view.title) is load-bearing: panel-placement.spec.ts
//          finds the rail item with getByRole("button", { name: "Animation" }).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ActivityBar, ACTIVITY_BAR_WIDTH } from "../ActivityBar";
import { useActivityBarStore } from "../useActivityBarStore";
import { ActivityBarExtensions } from "../../registries/activityBarExtensions";
import { panelRegistry, initPanelRegistry } from "../../registries/panelRegistry";
import { usePanelPlacementStore } from "../../registries/usePanelPlacementStore";
import { onAppEvent } from "../../../api/events";
import { setDesignMode } from "../../../api/designMode";
import { markObjectScript, unmarkObjectScript } from "../../../api/objectScriptBadge";
import {
  SurfaceLayoutProvider,
  bandLayout,
  panelLayout,
  findHardcodedColours,
  type SurfaceLayout,
} from "../../../api/layout";
import { RibbonIcon } from "../../../api/ribbonIcons";
import type { PanelDefinition } from "../../../api/uiTypes";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root;

const noop = () => {};

function makePanel(over: Partial<PanelDefinition> = {}): PanelDefinition {
  return {
    id: "test.animation",
    title: "Animation",
    icon: <RibbonIcon.Play size={16} />,
    sections: [{ id: "s", label: "S", component: () => null }],
    defaultPlacement: "sidebar",
    ...over,
  };
}

function registerViews(): void {
  ActivityBarExtensions.registerView({
    id: "view.explorer",
    title: "Explorer",
    icon: <RibbonIcon.Folder size={16} />,
    component: () => null,
    priority: 10,
  });
  ActivityBarExtensions.registerView({
    id: "view.search",
    title: "Search",
    icon: <RibbonIcon.Search size={14} />,
    component: () => null,
    priority: 5,
  });
  ActivityBarExtensions.registerView({
    id: "view.settings",
    title: "Settings",
    icon: <RibbonIcon.Settings size={16} />,
    component: () => null,
    bottom: true,
  });
}

function render(layout?: SurfaceLayout): void {
  act(() => {
    root.render(
      layout ? (
        <SurfaceLayoutProvider value={layout}>
          <ActivityBar />
        </SurfaceLayoutProvider>
      ) : (
        <ActivityBar />
      ),
    );
  });
}

function railButton(name: string): HTMLButtonElement {
  const btn = container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  if (!btn) throw new Error(`no rail button named "${name}" — every assertion would be vacuous`);
  return btn;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  initPanelRegistry({
    activityBar: {
      registerView: (def) => ActivityBarExtensions.registerView(def),
      unregisterView: (id) => ActivityBarExtensions.unregisterView(id),
    },
    extensionRegistry: { registerRibbonTab: noop, unregisterRibbonTab: noop },
    getActivityBarStore: () => useActivityBarStore.getState(),
  });
  usePanelPlacementStore.setState({ placements: {} });
  panelRegistry.clear();
  ActivityBarExtensions.clear();
  useActivityBarStore.setState({ isOpen: false, activeViewId: null, viewData: undefined });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  setDesignMode(false);
  unmarkObjectScript("panel", "test.animation");
  panelRegistry.clear();
  ActivityBarExtensions.clear();
});

describe("activity rail — structure and names", () => {
  it("renders top views in priority order and bottom views in the bottom section", () => {
    registerViews();
    render();

    const rail = container.querySelector<HTMLElement>("[data-activity-bar]");
    expect(rail).not.toBeNull();
    const [top, bottom] = Array.from(rail!.children) as HTMLElement[];
    const names = (section: HTMLElement) =>
      Array.from(section.querySelectorAll("button")).map((b) => b.getAttribute("aria-label"));
    expect(names(top)).toEqual(["Explorer", "Search"]);
    expect(names(bottom)).toEqual(["Settings"]);
  });

  it("keeps aria-label AND title equal to the view title (E2E finds items by name)", () => {
    registerViews();
    render();
    for (const name of ["Explorer", "Search", "Settings"]) {
      const btn = railButton(name);
      expect(btn.getAttribute("title")).toBe(name);
      expect(btn.getAttribute("type")).toBe("button");
    }
  });

  it("is 48px wide with 48px items hosting a chip that carries the icon", () => {
    registerViews();
    render();
    expect(ACTIVITY_BAR_WIDTH).toBe(48);
    const btn = railButton("Explorer");
    const chip = btn.querySelector("[data-rail-chip]");
    expect(chip, "the icon must sit inside the 40px chip").not.toBeNull();
    expect(chip!.querySelector("svg")).not.toBeNull();
  });

  it("no longer dims icons through inline opacity or paints a literal white bar", () => {
    registerViews();
    useActivityBarStore.setState({ isOpen: true, activeViewId: "view.explorer" });
    render();
    for (const el of Array.from(container.querySelectorAll<HTMLElement>("*"))) {
      expect(el.style.opacity, `inline opacity on <${el.tagName.toLowerCase()}>`).toBe("");
    }
  });
});

describe("activity rail — active state and toggling", () => {
  it("marks exactly the open view with aria-current", () => {
    registerViews();
    useActivityBarStore.setState({ isOpen: true, activeViewId: "view.search" });
    render();
    expect(railButton("Search").getAttribute("aria-current")).toBe("true");
    expect(railButton("Explorer").hasAttribute("aria-current")).toBe(false);
    expect(railButton("Settings").hasAttribute("aria-current")).toBe(false);
  });

  it("does not mark the remembered view while the panel is closed", () => {
    registerViews();
    useActivityBarStore.setState({ isOpen: false, activeViewId: "view.search" });
    render();
    expect(railButton("Search").hasAttribute("aria-current")).toBe(false);
  });

  it("click opens, click again closes, and the panel events fire in order", () => {
    registerViews();
    render();
    const events: string[] = [];
    const offs = ["panel:clicked", "panel:activated", "panel:shown", "panel:deactivated", "panel:hidden"].map(
      (name) => onAppEvent(name, () => events.push(name)),
    );
    try {
      act(() => railButton("Explorer").click());
      expect(useActivityBarStore.getState().isOpen).toBe(true);
      expect(useActivityBarStore.getState().activeViewId).toBe("view.explorer");
      expect(railButton("Explorer").getAttribute("aria-current")).toBe("true");
      expect(events).toEqual(["panel:clicked", "panel:activated", "panel:shown"]);

      events.length = 0;
      act(() => railButton("Explorer").click());
      expect(useActivityBarStore.getState().isOpen).toBe(false);
      expect(railButton("Explorer").hasAttribute("aria-current")).toBe(false);
      expect(events).toEqual(["panel:clicked", "panel:deactivated", "panel:hidden"]);
    } finally {
      offs.forEach((off) => off());
    }
  });
});

describe("activity rail — badges", () => {
  it("renders the notification badge from panelRegistry.setBadge", () => {
    panelRegistry.registerPanel(makePanel());
    render();
    expect(railButton("Animation").querySelector("[data-rail-badge]")).toBeNull();

    act(() => panelRegistry.setBadge("test.animation", "3"));
    const badge = railButton("Animation").querySelector<HTMLElement>("[data-rail-badge]");
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe("3");
    // The shared @api Badge (accent tone), not a private pill.
    expect(badge!.getAttribute("data-tone")).toBe("accent");
  });

  it("renders the JS script pill only in design mode for a scripted panel", () => {
    panelRegistry.registerPanel(makePanel());
    render();
    act(() => markObjectScript("panel", "test.animation"));
    expect(railButton("Animation").querySelector("[data-rail-script-badge]")).toBeNull();

    act(() => setDesignMode(true));
    const pill = railButton("Animation").querySelector<HTMLElement>("[data-rail-script-badge]");
    expect(pill).not.toBeNull();
    expect(pill!.textContent).toBe("JS");
    expect(pill!.getAttribute("title")).toBe("This panel has a script");
    expect(pill!.getAttribute("data-tone")).toBe("accent");
  });
});

describe("activity rail — move menu", () => {
  it("right-click on a movable panel's item opens the placement menu", () => {
    panelRegistry.registerPanel(makePanel());
    render();
    act(() => {
      railButton("Animation").dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 20 }),
      );
    });
    const move = Array.from(document.body.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").includes("Move to Ribbon"),
    );
    expect(move, "the right-click menu offers Move to Ribbon").toBeTruthy();
  });

  it("right-click on a view with no panel shows no menu", () => {
    registerViews();
    render();
    act(() => {
      railButton("Explorer").dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      );
    });
    const move = Array.from(document.body.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").includes("Move to"),
    );
    expect(move).toBeUndefined();
  });
});

describe("activity rail — follows the skin", () => {
  for (const [name, layout] of [
    ["band", bandLayout()],
    ["panel", panelLayout()],
  ] as const) {
    it(`paints no hardcoded colour (${name} layout, active item + both badges)`, () => {
      panelRegistry.registerPanel(makePanel());
      registerViews();
      act(() => {
        panelRegistry.setBadge("test.animation", "2");
        markObjectScript("panel", "test.animation");
        setDesignMode(true);
      });
      useActivityBarStore.setState({ isOpen: true, activeViewId: "test.animation" });
      render(layout);
      // Non-vacuity: the states whose chrome changed are actually on screen.
      expect(railButton("Animation").getAttribute("aria-current")).toBe("true");
      expect(container.querySelector("[data-rail-badge]")).not.toBeNull();
      expect(container.querySelector("[data-rail-script-badge]")).not.toBeNull();
      expect(findHardcodedColours(container)).toEqual([]);
    });
  }
});
