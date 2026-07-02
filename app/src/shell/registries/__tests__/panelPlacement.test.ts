// Tests for the panel placement contract: placement is TOTAL freedom — the
// user can move any movable panel to either surface. Layout safety is the
// section renderers' job (too-tall ribbon sections demote to launcher
// flyouts), so the registry never refuses a move for layout reasons.
// supportedPlacements survives only as a soft product-intent hint surfaced
// through getMoveHint.

import { describe, it, expect, beforeEach } from "vitest";
import React from "react";
import { panelRegistry, getSupportedPlacements, initPanelRegistry } from "../panelRegistry";
import { usePanelPlacementStore } from "../usePanelPlacementStore";
import type { PanelDefinition, ActivityViewDefinition } from "../../../api/uiTypes";

const noop = () => {};

let registeredTabs: string[];
let registeredViews: ActivityViewDefinition[];

beforeEach(() => {
  registeredTabs = [];
  registeredViews = [];
  // Recording stubs so projection targets can be asserted.
  initPanelRegistry({
    activityBar: {
      registerView: (def) => registeredViews.push(def),
      unregisterView: noop,
    },
    extensionRegistry: {
      registerRibbonTab: (tab) => registeredTabs.push(tab.id),
      unregisterRibbonTab: noop,
    },
    getActivityBarStore: () => ({ openView: noop, close: noop, activeViewId: null }),
  });
  usePanelPlacementStore.setState({ placements: {} });
  panelRegistry.clear();
});

function makePanel(over: Partial<PanelDefinition> = {}): PanelDefinition {
  return {
    id: "test.panel",
    title: "Test",
    icon: React.createElement("span"),
    sections: [{ id: "s", label: "S", component: () => null }],
    defaultPlacement: "sidebar",
    ...over,
  };
}

describe("getSupportedPlacements", () => {
  it("defaults to both surfaces when unset", () => {
    expect(getSupportedPlacements(makePanel())).toEqual(["sidebar", "ribbon"]);
  });

  it("defaults to both when the declared list is empty", () => {
    expect(getSupportedPlacements(makePanel({ supportedPlacements: [] }))).toEqual(["sidebar", "ribbon"]);
  });

  it("respects a declared subset", () => {
    expect(getSupportedPlacements(makePanel({ supportedPlacements: ["sidebar"] }))).toEqual(["sidebar"]);
  });
});

describe("total placement freedom", () => {
  it("allows moving a both-surface panel to the ribbon", () => {
    panelRegistry.registerPanel(makePanel());
    expect(panelRegistry.canMoveTo("test.panel", "ribbon")).toBe(true);
    panelRegistry.setPlacement("test.panel", "ribbon");
    expect(panelRegistry.getPlacement("test.panel")).toBe("ribbon");
  });

  it("allows moving a sidebar-preferring panel to the ribbon (hint, not lock)", () => {
    panelRegistry.registerPanel(makePanel({ supportedPlacements: ["sidebar"] }));
    expect(panelRegistry.canMoveTo("test.panel", "ribbon")).toBe(true);
    panelRegistry.setPlacement("test.panel", "ribbon");
    expect(panelRegistry.getPlacement("test.panel")).toBe("ribbon");
    expect(registeredTabs).toContain("test.panel");
  });

  it("never reports a non-movable panel as movable", () => {
    panelRegistry.registerPanel(makePanel({ movable: false }));
    expect(panelRegistry.canMoveTo("test.panel", "ribbon")).toBe(false);
    panelRegistry.setPlacement("test.panel", "ribbon");
    expect(panelRegistry.getPlacement("test.panel")).toBe("sidebar");
  });

  it("honors a persisted placement even outside the declared preference", () => {
    // A panel moved to the ribbon in a previous session stays there — the
    // renderers guarantee a legal layout, so nothing is clamped or cleared.
    usePanelPlacementStore.setState({ placements: { ["test.panel"]: "ribbon" } });
    panelRegistry.registerPanel(makePanel({ supportedPlacements: ["sidebar"] }));
    expect(panelRegistry.getPlacement("test.panel")).toBe("ribbon");
    expect(usePanelPlacementStore.getState().placements["test.panel"]).toBe("ribbon");
    expect(registeredTabs).toContain("test.panel");
  });
});

describe("getMoveHint", () => {
  it("returns null when the panel declares no preference", () => {
    panelRegistry.registerPanel(makePanel());
    expect(panelRegistry.getMoveHint("test.panel", "ribbon")).toBeNull();
  });

  it("returns null when the target is a preferred surface", () => {
    panelRegistry.registerPanel(makePanel({ supportedPlacements: ["sidebar"] }));
    expect(panelRegistry.getMoveHint("test.panel", "sidebar")).toBeNull();
  });

  it("hints when the target is outside the declared preference", () => {
    panelRegistry.registerPanel(makePanel({ supportedPlacements: ["sidebar"] }));
    expect(panelRegistry.getMoveHint("test.panel", "ribbon")).toBe("Works best in the sidebar");
  });
});

describe("hidden panels", () => {
  it("projects to the sidebar with hidden=true (no icon-strip presence)", () => {
    panelRegistry.registerPanel(makePanel({ hidden: true }));
    expect(registeredViews).toHaveLength(1);
    expect(registeredViews[0].hidden).toBe(true);
  });

  it("never registers a ribbon tab for a hidden panel", () => {
    panelRegistry.registerPanel(makePanel({ hidden: true, defaultPlacement: "ribbon" }));
    expect(registeredTabs).toHaveLength(0);
  });
});
