//! FILENAME: app/src/shell/ActivityBar/__tests__/SidePanel.test.tsx
// PURPOSE: The side panel after the Calcula Clusters redesign — a 40px header
//          with the view's icon, a sentence-case title, a "More" button that
//          opens the SAME placement menu the header right-click opens, and a
//          "Close panel" button that closes through the store; plus a resize
//          handle that shows an accent line and still persists the width.
// CONTEXT: The header used to be an uppercase 11px label with a hand-drawn
//          close glyph. Every colour is now a token, which the last block checks
//          on the rendered DOM.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SidePanel, SIDE_PANEL_HEADER_HEIGHT } from "../SidePanel";
import { useActivityBarStore } from "../useActivityBarStore";
import { ActivityBarExtensions } from "../../registries/activityBarExtensions";
import { panelRegistry, initPanelRegistry } from "../../registries/panelRegistry";
import { usePanelPlacementStore } from "../../registries/usePanelPlacementStore";
import {
  SurfaceLayoutProvider,
  bandLayout,
  panelLayout,
  findHardcodedColours,
  type SurfaceLayout,
} from "../../../api/layout";
import { RibbonIcon } from "../../../api/ribbonIcons";
import type { ActivityViewProps, PanelDefinition } from "../../../api/uiTypes";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root;

const noop = () => {};

function Body({ data }: ActivityViewProps): React.ReactElement {
  return <div data-testid="view-body">body {String(data?.tag ?? "")}</div>;
}

function makePanel(over: Partial<PanelDefinition> = {}): PanelDefinition {
  return {
    id: "test.animation",
    title: "Animation timeline",
    icon: <RibbonIcon.Play size={14} />,
    sections: [{ id: "s", label: "S", component: () => <div data-testid="section-body">section</div> }],
    defaultPlacement: "sidebar",
    ...over,
  };
}

function render(layout?: SurfaceLayout): void {
  act(() => {
    root.render(
      layout ? (
        <SurfaceLayoutProvider value={layout}>
          <SidePanel />
        </SurfaceLayoutProvider>
      ) : (
        <SidePanel />
      ),
    );
  });
}

function button(name: string): HTMLButtonElement {
  const btn = container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  if (!btn) throw new Error(`no button named "${name}"`);
  return btn;
}

function header(): HTMLElement {
  const panel = container.querySelector<HTMLElement>("[data-side-panel]");
  if (!panel) throw new Error("the side panel did not render");
  return panel.firstElementChild as HTMLElement;
}

function menuItem(text: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
    (b.textContent ?? "").includes(text),
  );
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
  useActivityBarStore.setState({ isOpen: false, activeViewId: null, viewData: undefined, width: 320 });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  panelRegistry.clear();
  ActivityBarExtensions.clear();
});

describe("side panel — header", () => {
  it("renders nothing while closed", () => {
    ActivityBarExtensions.registerView({ id: "v", title: "Explorer", icon: null, component: Body });
    render();
    expect(container.querySelector("[data-side-panel]")).toBeNull();
  });

  it("shows the view's icon, its title in sentence case, and the view body", () => {
    ActivityBarExtensions.registerView({
      id: "v",
      title: "Workbook explorer",
      icon: <RibbonIcon.Folder size={14} />,
      component: Body,
    });
    useActivityBarStore.setState({ isOpen: true, activeViewId: "v", viewData: { tag: "x1" } });
    render();

    const h = header();
    expect(h.textContent).toContain("Workbook explorer");
    // Sentence case: the title is rendered as authored, never text-transformed.
    const title = Array.from(h.querySelectorAll("span")).find((s) => s.textContent === "Workbook explorer");
    expect(title).toBeTruthy();
    expect(title!.style.textTransform).toBe("");
    // The icon is in the header, before the title.
    expect(h.querySelector("svg")).not.toBeNull();
    // Content + open-time data still reach the view.
    expect(container.querySelector("[data-testid='view-body']")!.textContent).toBe("body x1");
    expect(SIDE_PANEL_HEADER_HEIGHT).toBe(40);
  });

  it("renders no icon slot when the view has none", () => {
    ActivityBarExtensions.registerView({ id: "v", title: "Plain", icon: null, component: Body });
    useActivityBarStore.setState({ isOpen: true, activeViewId: "v" });
    render();
    // Only the Close button's glyph is an svg in the header.
    const svgs = header().querySelectorAll("svg");
    expect(svgs.length).toBe(1);
    expect(button("Close panel").contains(svgs[0])).toBe(true);
  });

  it("Close panel closes the side panel through the store", () => {
    ActivityBarExtensions.registerView({ id: "v", title: "Explorer", icon: null, component: Body });
    useActivityBarStore.setState({ isOpen: true, activeViewId: "v" });
    render();
    act(() => button("Close panel").click());
    expect(useActivityBarStore.getState().isOpen).toBe(false);
    expect(container.querySelector("[data-side-panel]")).toBeNull();
  });
});

describe("side panel — More menu", () => {
  it("More opens the same placement menu the header right-click opens", () => {
    panelRegistry.registerPanel(makePanel());
    useActivityBarStore.setState({ isOpen: true, activeViewId: "test.animation" });
    render();

    const more = button("More");
    expect(more.getAttribute("aria-haspopup")).toBe("menu");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(menuItem("Move to Ribbon")).toBeUndefined();

    act(() => more.click());
    expect(menuItem("Move to Ribbon"), "More did not open the placement menu").toBeTruthy();
    expect(menuItem("Edit Script...")).toBeTruthy();
    expect(button("More").getAttribute("aria-expanded")).toBe("true");

    // A second click on More closes it again (it does not flicker open).
    act(() => {
      button("More").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      button("More").click();
    });
    expect(menuItem("Move to Ribbon")).toBeUndefined();

    // The header right-click opens the very same menu.
    act(() => {
      header().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    });
    expect(menuItem("Move to Ribbon")).toBeTruthy();
  });

  it("Move to Ribbon from the More menu moves the panel", () => {
    panelRegistry.registerPanel(makePanel());
    useActivityBarStore.setState({ isOpen: true, activeViewId: "test.animation" });
    render();
    act(() => button("More").click());
    act(() => menuItem("Move to Ribbon")!.click());
    expect(panelRegistry.getPlacement("test.animation")).toBe("ribbon");
  });

  it("offers no More button for a view with no movable panel", () => {
    panelRegistry.registerPanel(makePanel({ movable: false }));
    useActivityBarStore.setState({ isOpen: true, activeViewId: "test.animation" });
    render();
    expect(container.querySelector('button[aria-label="More"]')).toBeNull();
    expect(button("Close panel")).toBeTruthy();
  });
});

describe("side panel — resize handle", () => {
  it("drags the width through the store and marks the handle while dragging", () => {
    ActivityBarExtensions.registerView({ id: "v", title: "Explorer", icon: null, component: Body });
    useActivityBarStore.setState({ isOpen: true, activeViewId: "v", width: 300 });
    render();
    const panel = container.querySelector<HTMLElement>("[data-side-panel]")!;
    const handle = panel.lastElementChild as HTMLElement;
    expect(handle.hasAttribute("data-resizing")).toBe(false);

    act(() => {
      handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 300 }));
    });
    expect(handle.getAttribute("data-resizing")).toBe("true");

    act(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 340 }));
    });
    expect(useActivityBarStore.getState().width).toBe(340);

    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    expect(handle.hasAttribute("data-resizing")).toBe(false);
    expect(panel.style.width).toBe("340px");
  });
});

describe("side panel — follows the skin", () => {
  for (const [name, layout] of [
    ["band", bandLayout()],
    ["panel", panelLayout()],
  ] as const) {
    it(`paints no hardcoded colour (${name} layout)`, () => {
      panelRegistry.registerPanel(makePanel());
      useActivityBarStore.setState({ isOpen: true, activeViewId: "test.animation" });
      render(layout);
      // Non-vacuity: the icon, both header buttons and the section body are up.
      expect(container.querySelector("[data-testid='section-body']")).not.toBeNull();
      expect(button("More")).toBeTruthy();
      expect(header().querySelectorAll("svg").length).toBe(3);

      // The header — icon, title, More, Close — is all this file's chrome.
      expect(findHardcodedColours(header())).toEqual([]);

      // The frame and the resize handle, scanned WITHOUT the hosted content:
      // the section body is the Shell section renderer's surface and the
      // placement menu is the Ribbon's PanelContextMenu, each covered by its
      // owner's tests. A shallow clone keeps the element's class, which is
      // what the helper resolves the stylesheet rules through.
      const panel = container.querySelector<HTMLElement>("[data-side-panel]")!;
      for (const el of [panel, panel.lastElementChild as HTMLElement]) {
        const probe = document.createElement("div");
        probe.appendChild(el.cloneNode(false));
        document.body.appendChild(probe);
        try {
          expect(findHardcodedColours(probe)).toEqual([]);
        } finally {
          probe.remove();
        }
      }
    });
  }
});
