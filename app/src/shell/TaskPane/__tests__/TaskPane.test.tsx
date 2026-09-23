//! FILENAME: app/src/shell/TaskPane/__tests__/TaskPane.test.tsx
// PURPOSE: The task pane after the Calcula Clusters redesign — the shared 40px
//          header (one view: icon + title; several: the @api SegmentedTabs
//          pill with a per-view close), the exact `title="Close Task Pane"`
//          E2E selects, the RibbonIcon.Panel empty state, and no hardcoded
//          colour in anything the frame renders.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TaskPaneContainer } from "../TaskPaneContainer";
import { useTaskPaneStore } from "../useTaskPaneStore";
import { registerTaskPaneService, type TaskPaneService } from "../../../api/ui";
import type { TaskPaneViewDefinition, TaskPaneViewProps } from "../../../api/uiTypes";
import {
  SurfaceLayoutProvider,
  bandLayout,
  panelLayout,
  findHardcodedColours,
  type SurfaceLayout,
} from "../../../api/layout";
import { RibbonIcon } from "../../../api/ribbonIcons";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let container: HTMLDivElement;
let root: Root;
const views = new Map<string, TaskPaneViewDefinition>();

function Body({ data }: TaskPaneViewProps): React.ReactElement {
  return <div data-testid="pane-body">{String(data?.tag ?? "body")}</div>;
}

/** Just enough of the Shell's service for the header and container to resolve views. */
const service: TaskPaneService = {
  registerView: (def) => void views.set(def.id, def),
  unregisterView: (id) => void views.delete(id),
  getView: (id) => views.get(id),
  getAllViews: () => Array.from(views.values()),
  getViewsForContext: () => [],
  openPane: () => {},
  closePane: () => {},
  open: () => {},
  close: () => {},
  isOpen: () => false,
  getManuallyClosed: () => [],
  markManuallyClosed: () => {},
  clearManuallyClosed: () => {},
  addActiveContextKey: () => {},
  removeActiveContextKey: () => {},
  onRegistryChange: () => () => {},
};

function view(id: string, title: string, icon?: React.ReactNode, closable?: boolean): void {
  views.set(id, { id, title, icon, component: Body, contextKeys: ["always"], closable });
}

function render(layout?: SurfaceLayout): void {
  act(() => {
    root.render(
      layout ? (
        <SurfaceLayoutProvider value={layout}>
          <TaskPaneContainer />
        </SurfaceLayoutProvider>
      ) : (
        <TaskPaneContainer />
      ),
    );
  });
}

function closePaneButton(): HTMLButtonElement {
  const btn = container.querySelector<HTMLButtonElement>('button[title="Close Task Pane"]');
  if (!btn) throw new Error('no button[title="Close Task Pane"] — insight-overlays.spec.ts selects it');
  return btn;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  views.clear();
  registerTaskPaneService(service);
  useTaskPaneStore.getState().reset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  useTaskPaneStore.getState().reset();
});

describe("task pane — one open view", () => {
  it("shows the view's icon and title in the header, with no tab strip", () => {
    view("fmt", "Format chart", <RibbonIcon.Palette size={20} />);
    act(() => useTaskPaneStore.getState().openPane("fmt", { tag: "d1" }));
    render();

    expect(container.querySelector('[role="tablist"]')).toBeNull();
    const header = closePaneButton().closest("div")!.parentElement as HTMLElement;
    expect(header.textContent).toContain("Format chart");
    // The icon is in the header, before the close button's own glyph.
    expect(header.querySelectorAll("svg").length).toBe(2);
    expect(container.querySelector("[data-testid='pane-body']")!.textContent).toBe("d1");
    // One view: no separate per-view close next to the pane close.
    expect(container.querySelector('button[aria-label^="Close Format"]')).toBeNull();
  });

  it("does not render a bracketed text placeholder as an icon", () => {
    view("bi", "BI", "[BI]");
    act(() => useTaskPaneStore.getState().openPane("bi"));
    render();
    expect(container.textContent).not.toContain("[BI]");
  });

  it("Close Task Pane keeps its exact title, closes, and marks every open view", () => {
    view("fmt", "Format chart");
    act(() => useTaskPaneStore.getState().openPane("fmt"));
    render();
    const btn = closePaneButton();
    expect(btn.getAttribute("aria-label")).toBe("Close Task Pane");
    act(() => btn.click());
    const state = useTaskPaneStore.getState();
    expect(state.isOpen).toBe(false);
    expect(state.manuallyClosed).toEqual(["fmt"]);
  });
});

describe("task pane — several open views", () => {
  beforeEach(() => {
    view("fmt", "Format", <RibbonIcon.Palette size={20} />);
    view("json", "JSON", <RibbonIcon.Code size={20} />);
    act(() => {
      useTaskPaneStore.getState().openPane("fmt");
      useTaskPaneStore.getState().openPane("json");
    });
  });

  it("switches views through the SegmentedTabs pill", () => {
    render();
    const tablist = container.querySelector('[role="tablist"]');
    expect(tablist).not.toBeNull();
    const tabs = Array.from(tablist!.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(tabs.map((t) => t.textContent)).toEqual(["Format", "JSON"]);
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["false", "true"]);
    // Each tab's icon sits in the 16px slot.
    expect(tabs.every((t) => t.querySelector("svg") !== null)).toBe(true);

    act(() => tabs[0].click());
    expect(useTaskPaneStore.getState().activeViewId).toBe("fmt");
    const after = Array.from(container.querySelectorAll('[role="tab"]'));
    expect(after.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false"]);
  });

  it("closes only the active view with its own close button", () => {
    render();
    const closeView = container.querySelector<HTMLButtonElement>('button[aria-label="Close JSON"]');
    expect(closeView, "the per-view close is gone").not.toBeNull();
    act(() => closeView!.click());
    const state = useTaskPaneStore.getState();
    expect(state.openPanes.map((p) => p.viewId)).toEqual(["fmt"]);
    expect(state.activeViewId).toBe("fmt");
    expect(state.manuallyClosed).toEqual(["json"]);
    expect(state.isOpen).toBe(true);
    // Back to one view: the tab strip collapses to the title row.
    expect(container.querySelector('[role="tablist"]')).toBeNull();
  });

  it("offers no per-view close for a view that is not closable", () => {
    view("json", "JSON", <RibbonIcon.Code size={20} />, false);
    render();
    expect(container.querySelector('button[aria-label="Close JSON"]')).toBeNull();
    expect(closePaneButton()).toBeTruthy();
  });
});

describe("task pane — empty state", () => {
  it("shows RibbonIcon.Panel and the message instead of a [?] glyph", () => {
    act(() => useTaskPaneStore.setState({ isOpen: true, openPanes: [], activeViewId: null }));
    render();
    expect(container.textContent).toContain("No pane selected");
    expect(container.textContent).not.toContain("[?]");
    const message = Array.from(container.querySelectorAll("p")).find((p) => p.textContent === "No pane selected");
    expect(message!.parentElement!.querySelector("svg")).not.toBeNull();
    // The pane close is always rendered (insight-overlays counts it).
    expect(closePaneButton()).toBeTruthy();
  });
});

describe("task pane — follows the skin", () => {
  for (const [name, layout] of [
    ["band", bandLayout()],
    ["panel", panelLayout()],
  ] as const) {
    it(`paints no hardcoded colour (${name} layout, tabs + per-view close)`, () => {
      view("fmt", "Format", <RibbonIcon.Palette size={20} />);
      view("json", "JSON", <RibbonIcon.Code size={20} />);
      act(() => {
        useTaskPaneStore.getState().openPane("fmt");
        useTaskPaneStore.getState().openPane("json");
      });
      render(layout);
      expect(container.querySelector('[role="tablist"]')).not.toBeNull();
      expect(findHardcodedColours(container)).toEqual([]);
    });
  }

  it("paints no hardcoded colour in the empty state", () => {
    act(() => useTaskPaneStore.setState({ isOpen: true, openPanes: [], activeViewId: null }));
    render();
    expect(findHardcodedColours(container)).toEqual([]);
  });
});
